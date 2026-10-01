import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { MAX_PLAYERS_PER_ROOM, NO_INPUT, type ServerMessage } from '@game/shared';
import { asFullSnapshots } from './deltas';
import { GameServer } from '../src/GameServer';

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** A lobby client: connects without joining and records every message. */
class Client {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly opened: Promise<void>;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://localhost:${port}`);
    this.socket.on('message', (data) => this.messages.push(...asFullSnapshots(this, JSON.parse(data.toString()) as ServerMessage)));
    this.opened = new Promise((resolve) => this.socket.once('open', () => resolve()));
  }

  async next<T extends ServerMessage['type']>(type: T, where: (m: Of<T>) => boolean = () => true, timeoutMs = 3000): Promise<Of<T>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find((m): m is Of<T> => m.type === type && where(m as Of<T>));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no matching '${type}' message within ${timeoutMs}ms`);
  }

  async send(message: object): Promise<void> {
    await this.opened;
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

async function withServer(options: Partial<ConstructorParameters<typeof GameServer>[0]>, body: (server: GameServer) => Promise<void>) {
  const server = new GameServer({ port: 0, seed: 1234, ...options });
  await server.listening();
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

test('the lobby lists the permanent default room as soon as you connect', () =>
  withServer({ defaultRoomName: 'Downtown' }, async (server) => {
    const lobby = new Client(server.port);
    const { rooms } = await lobby.next('rooms');
    assert.equal(rooms.length, 1);
    assert.deepEqual({ ...rooms[0], id: undefined }, { id: undefined, name: 'Downtown', mode: 'frag', players: 0, maxPlayers: MAX_PLAYERS_PER_ROOM, phase: 'playing', police: 'on' });
    lobby.close();
  }));

test('creating a room joins it, and the lobby sees it appear with its mode and players', () =>
  withServer({}, async (server) => {
    const lobby = new Client(server.port);
    await lobby.next('rooms');
    const host = new Client(server.port);
    await host.send({ type: 'createRoom', name: 'Alice', room: { name: 'Tag   night\u0000', mode: 'tag', scoreLimit: 30, timeLimitMinutes: 5 } });
    const welcome = await host.next('welcome');
    assert.equal(welcome.roomName, 'Tag night');
    const first = await host.next('snapshot');
    assert.equal(first.match.mode, 'tag');
    assert.equal(first.match.scoreLimit, 30 * 60, '30 seconds as "it", in ticks');

    const { rooms } = await lobby.next('rooms', (m) => m.rooms.length === 2);
    const created = rooms.find((r) => r.id === welcome.roomId);
    assert.deepEqual([created?.name, created?.mode, created?.players], ['Tag night', 'tag', 1]);
    host.close();
    lobby.close();
  }));

test('a room can be created without police: no cops, no police cars, and the lobby says so', () =>
  withServer({ city: { cops: 4, policeCars: 2, police: 'on' } }, async (server) => {
    const lobby = new Client(server.port);
    await lobby.next('rooms');
    const host = new Client(server.port);
    await host.send({ type: 'createRoom', name: 'Alice', room: { name: 'Calm', mode: 'frag', police: 'off' } });
    const welcome = await host.next('welcome');
    const { rooms } = await lobby.next('rooms', (m) => m.rooms.length === 2);
    assert.equal(rooms.find((r) => r.id === welcome.roomId)?.police, 'off');
    assert.equal(rooms.find((r) => r.id !== welcome.roomId)?.police, 'on', 'the default room keeps the server setting');
    const snapshot = await host.next('snapshot', (s) => s.tick > 120);
    assert.equal(snapshot.peds.filter((p) => p.kind === 'cop').length, 0);
    assert.equal(snapshot.cars.filter((c) => c.police).length, 0);
    host.close();
    lobby.close();
  }));

test('rooms are separate games: players only see the people in their own room', () =>
  withServer({}, async (server) => {
    const a = new Client(server.port);
    await a.send({ type: 'createRoom', name: 'Alice', room: { name: 'A', mode: 'frag' } });
    const inA = await a.next('welcome');
    const b = new Client(server.port);
    await b.send({ type: 'join', name: 'Bob' }); // no room id: the default room
    const inDefault = await b.next('welcome');
    assert.notEqual(inA.roomId, inDefault.roomId);

    const snapshotA = await a.next('snapshot', (s) => s.tick > 5);
    assert.deepEqual(snapshotA.players.map((p) => p.name), ['Alice']);
    const snapshotB = await b.next('snapshot', (s) => s.tick > 5);
    assert.deepEqual(snapshotB.players.map((p) => p.name), ['Bob']);

    // And inputs only move your own ped in your own room.
    for (let seq = 1; seq <= 10; seq++) await b.send({ type: 'input', seq, input: { ...NO_INPUT, left: true } });
    await b.next('snapshot', (s) => s.acks[inDefault.pedId] === 10);
    a.close();
    b.close();
  }));

test('joining a room that is gone or full fails with a reason, and you stay in the lobby', () =>
  withServer({}, async (server) => {
    const lost = new Client(server.port);
    await lost.send({ type: 'join', name: 'Lost', roomId: 'no-such-room' });
    assert.match((await lost.next('joinFailed')).reason, /no longer exists/);

    const host = new Client(server.port);
    await host.send({ type: 'createRoom', name: 'Host', room: { name: 'Tiny', mode: 'frag' } });
    const { roomId } = await host.next('welcome');
    const guests = Array.from({ length: MAX_PLAYERS_PER_ROOM - 1 }, () => new Client(server.port));
    for (const guest of guests) await guest.send({ type: 'join', name: 'Guest', roomId });
    await Promise.all(guests.map((g) => g.next('welcome')));
    assert.equal(server.room(roomId)!.playerCount, MAX_PLAYERS_PER_ROOM);

    const late = new Client(server.port);
    await late.send({ type: 'join', name: 'Late', roomId });
    assert.match((await late.next('joinFailed')).reason, /full/);
    // Still in the lobby, so a second try elsewhere works.
    await late.send({ type: 'join', name: 'Late' });
    await late.next('welcome');
    [lost, host, late, ...guests].forEach((c) => c.close());
  }));

test('bad room settings are rejected or clamped', () =>
  withServer({}, async (server) => {
    const bad = new Client(server.port);
    await bad.send({ type: 'createRoom', name: 'X', room: { name: 'Nope', mode: 'capture-the-flag' } });
    await bad.send({ type: 'ping', time: 1 });
    await bad.next('pong');
    assert.ok(!bad.messages.some((m) => m.type === 'welcome'), 'unknown mode: nothing created');
    assert.equal(server.roomCount, 1);

    const greedy = new Client(server.port);
    await greedy.send({ type: 'createRoom', name: 'G', room: { name: 'Forever', mode: 'frag', scoreLimit: 1e9, timeLimitMinutes: -5 } });
    const first = await greedy.next('snapshot');
    assert.equal(first.match.scoreLimit, 1000);
    assert.equal(first.match.endsAt, null, 'negative time limit becomes "no limit"');
    bad.close();
    greedy.close();
  }));

test('created rooms close once empty for a while; the default room stays', () =>
  withServer({ emptyRoomTicks: 30 }, async (server) => {
    const host = new Client(server.port);
    await host.send({ type: 'createRoom', name: 'Host', room: { name: 'Brief', mode: 'points' } });
    const { roomId } = await host.next('welcome');
    assert.equal(server.roomCount, 2);
    host.close();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(server.room(roomId), undefined);
    assert.equal(server.roomCount, 1);
  }));

test('the number of rooms is capped', () =>
  withServer({ maxRooms: 2 }, async (server) => {
    const first = new Client(server.port);
    await first.send({ type: 'createRoom', name: 'A', room: { name: 'One', mode: 'frag' } });
    await first.next('welcome');
    const second = new Client(server.port);
    await second.send({ type: 'createRoom', name: 'B', room: { name: 'Two', mode: 'frag' } });
    assert.match((await second.next('joinFailed')).reason, /Too many rooms/);
    first.close();
    second.close();
  }));

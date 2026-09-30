import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { NO_INPUT, type ServerMessage } from '@game/shared';
import { asFullSnapshots } from './deltas';
import { GameServer } from '../src/GameServer';

let server: GameServer;

before(async () => {
  server = new GameServer({ port: 0, seed: 1234 });
  await server.listening();
});

after(() => server.close());

/** A test client that records every message it receives. */
class TestClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];

  /** Joins with `name` as soon as the connection opens, unless `name` is null. */
  constructor(port: number, name: string | null = 'Tester') {
    this.socket = new WebSocket(`ws://localhost:${port}`);
    this.socket.on('message', (data) => this.messages.push(...asFullSnapshots(this, JSON.parse(data.toString()) as ServerMessage)));
    if (name !== null) this.socket.on('open', () => this.send({ type: 'join', name }));
  }

  async next<T extends ServerMessage['type']>(type: T, where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type && where(m as Extract<ServerMessage, { type: T }>));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no '${type}' message within ${timeoutMs}ms`);
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

test('each client gets its own ped and sees the other players', async () => {
  const a = new TestClient(server.port);
  const b = new TestClient(server.port);
  const welcomeA = await a.next('welcome');
  const welcomeB = await b.next('welcome');
  assert.notEqual(welcomeA.pedId, welcomeB.pedId);
  assert.equal(welcomeA.seed, 1234);

  const snapshot = await a.next('snapshot', (s) => s.peds.some((p) => p.id === welcomeB.pedId));
  assert.ok(snapshot.peds.some((p) => p.id === welcomeA.pedId));
  assert.ok(snapshot.cars.length > 10);

  b.close();
  await a.next('snapshot', (s) => s.tick > snapshot.tick && !s.peds.some((p) => p.id === welcomeB.pedId));
  a.close();
});

test('the server applies inputs in order, one per tick, and acknowledges them', async () => {
  const client = new TestClient(server.port);
  const { pedId } = await client.next('welcome');
  const start = (await client.next('snapshot')).peds.find((p) => p.id === pedId)!;

  // 30 ticks of turning left, then 5 ticks of nothing.
  for (let seq = 1; seq <= 35; seq++) client.send({ type: 'input', seq, input: { ...NO_INPUT, left: seq <= 30 } });
  const done = await client.next('snapshot', (s) => s.acks[pedId] === 35);
  const ped = done.peds.find((p) => p.id === pedId)!;

  // Exactly 30 ticks of turning at 4.5 rad/s, no more, no less.
  const turned = Math.atan2(Math.sin(ped.heading - start.heading), Math.cos(ped.heading - start.heading));
  const expected = Math.atan2(Math.sin(30 * 4.5 / 60), Math.cos(30 * 4.5 / 60));
  // Snapshots round numbers to 0.0001 (both the start and end heading), so allow for that.
  assert.ok(Math.abs(turned - expected) < 2e-4, `turned ${turned}, expected ${expected}`);
  client.close();
});

test('duplicate and out-of-order inputs are ignored', async () => {
  const client = new TestClient(server.port);
  const { pedId } = await client.next('welcome');
  client.send({ type: 'input', seq: 5, input: NO_INPUT });
  client.send({ type: 'input', seq: 5, input: { ...NO_INPUT, left: true } });
  client.send({ type: 'input', seq: 3, input: { ...NO_INPUT, left: true } });
  const snap = await client.next('snapshot', (s) => s.acks[pedId] === 5);
  const later = await client.next('snapshot', (s) => s.tick > snap.tick + 4);
  assert.equal(later.acks[pedId], 5);
  assert.equal(later.peds.find((p) => p.id === pedId)!.heading, snap.peds.find((p) => p.id === pedId)!.heading);
  client.close();
});

test('malformed messages are ignored and ping is answered', async () => {
  const client = new TestClient(server.port);
  await client.next('welcome');
  client.socket.send('not json');
  client.send({ type: 'input', input: 'nonsense' });
  client.send({ type: 'ping', time: 42 });
  const pong = await client.next('pong');
  assert.equal(pong.time, 42);
  client.close();
});

test('players get sanitized, unique names that everyone can see', async () => {
  const a = new TestClient(server.port, '  Dave\u0000 the\nRave ');
  const { pedId: pedA } = await a.next('welcome');
  const b = new TestClient(server.port, 'dave THE rave');
  const { pedId: pedB } = await b.next('welcome');
  const c = new TestClient(server.port, '   ');
  const { pedId: pedC } = await c.next('welcome');

  const snapshot = await a.next('snapshot', (s) => s.players.length === 3);
  const names = new Map(snapshot.players.map((p) => [p.pedId, p.name]));
  assert.equal(names.get(pedA), 'Dave the Rave');
  assert.equal(names.get(pedB), 'dave THE rave 2');
  assert.match(names.get(pedC)!, /^Player \d+$/);
  [a, b, c].forEach((client) => client.close());
});

test('a connection gets no ped until it joins', async () => {
  const lurker = new TestClient(server.port, null);
  await new Promise((resolve) => lurker.socket.once('open', resolve));
  lurker.send({ type: 'input', seq: 1, input: { ...NO_INPUT, up: true } });
  lurker.send({ type: 'ping', time: 1 });
  await lurker.next('pong');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!lurker.messages.some((m) => m.type === 'welcome' || m.type === 'snapshot'));
  lurker.close();
});

test('snapshots carry every event since the previous snapshot', async () => {
  const client = new TestClient(server.port);
  const { pedId } = await client.next('welcome');
  // Arm the ped and stand it facing the city's west wall (cells x<1), 1.5 blocks away.
  const ped = server.world.peds.get(pedId)!;
  Object.assign(ped, { x: 2.5, y: 30.5, heading: Math.PI, weapon: 'machineGun', ammo: { machineGun: 10 } });

  for (let seq = 1; seq <= 60; seq++) client.send({ type: 'input', seq, input: { ...NO_INPUT, fire: true } });
  await client.next('snapshot', (s) => s.acks[pedId] === 60);
  await new Promise((r) => setTimeout(r, 200)); // let the last bullets land

  const impacts = client.messages.flatMap((m) => (m.type === 'snapshot' ? m.events : [])).filter((e) => e.type === 'impact' && e.ownerId === pedId);
  assert.equal(impacts.length, 10, 'one impact per bullet, none lost between snapshots');
  client.close();
});

test('a frag match: kills are scored, the match ends at the limit, players freeze, then it starts over', async () => {
  const quick = new GameServer({ port: 0, seed: 1234, match: { scoreLimits: { frag: 1, points: 0, tag: 0 }, intermissionTicks: 30 } });
  await quick.listening();
  const a = new TestClient(quick.port, 'Alice');
  const b = new TestClient(quick.port, 'Bob');
  const { pedId: alice } = await a.next('welcome');
  const { pedId: bob } = await b.next('welcome');

  // Alice gets a pistol and Bob stands three blocks in front of her.
  quick.world.cars.clear();
  Object.assign(quick.world.peds.get(alice)!, { x: 2.5, y: 30.5, heading: Math.PI / 2, weapon: 'pistol', ammo: { pistol: 10 } });
  Object.assign(quick.world.peds.get(bob)!, { x: 2.5, y: 33.5 });
  for (let seq = 1; seq <= 90; seq++) a.send({ type: 'input', seq, input: { ...NO_INPUT, fire: true } });

  const ended = await a.next('snapshot', (s) => s.match.phase === 'intermission', 3000);
  const score = (s: typeof ended, id: number) => s.players.find((p) => p.pedId === id)!;
  assert.deepEqual([score(ended, alice).frags, score(ended, bob).deaths], [1, 1]);
  assert.deepEqual(ended.match.winnerIds, [alice]);

  // Frozen: walking does nothing until the next match.
  const before = ended.peds.find((p) => p.id === alice)!;
  for (let seq = 91; seq <= 100; seq++) a.send({ type: 'input', seq, input: { ...NO_INPUT, up: true } });
  const stillFrozen = await a.next('snapshot', (s) => s.acks[alice] === 100 && s.match.phase === 'intermission');
  assert.equal(stillFrozen.peds.find((p) => p.id === alice)!.y, before.y);

  const fresh = await a.next('snapshot', (s) => s.match.phase === 'playing' && s.tick > ended.tick, 3000);
  assert.deepEqual([score(fresh, alice).frags, score(fresh, bob).deaths], [0, 0]);
  assert.ok(fresh.peds.every((p) => p.respawnAt === null && p.weapon === null), 'everyone back, unarmed');
  a.close();
  b.close();
  await quick.close();
});

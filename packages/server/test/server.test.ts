import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { NO_INPUT, type ServerMessage } from '@game/shared';
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

  constructor(port: number) {
    this.socket = new WebSocket(`ws://localhost:${port}`);
    this.socket.on('message', (data) => this.messages.push(JSON.parse(data.toString()) as ServerMessage));
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

test('the server moves a player according to their input', async () => {
  const client = new TestClient(server.port);
  const { pedId } = await client.next('welcome');
  const start = (await client.next('snapshot')).peds.find((p) => p.id === pedId)!;

  client.send({ type: 'input', input: { ...NO_INPUT, left: true } });
  const turned = await client.next('snapshot', (s) => Math.abs(s.peds.find((p) => p.id === pedId)!.heading - start.heading) > 0.5);
  assert.ok(turned);
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

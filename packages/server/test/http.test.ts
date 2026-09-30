import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { GameServer } from '../src/GameServer';

let server: GameServer;
let base: string;

before(async () => {
  // A stand-in for the built client, plus a "secret" file next to it that must not be reachable.
  const parent = await mkdtemp(join(tmpdir(), 'mlds-http-'));
  const dist = join(parent, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>game</title>');
  await writeFile(join(dist, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
  await writeFile(join(parent, 'secret.txt'), 'nope');
  server = new GameServer({ port: 0, seed: 1234, staticDir: dist });
  await server.listening();
  base = `http://localhost:${server.port}`;
});

after(() => server.close());

/** A raw GET, so paths like /../ are sent as-is instead of being cleaned up by fetch(). */
function get(path: string): Promise<{ status: number; type: string; cache: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), cache: String(res.headers['cache-control']), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the health check reports rooms and players', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, rooms: 1, players: 0 });
});

test('the built game is served, with long caching for hashed files only', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.equal(page.cache, 'no-cache');
  const script = await get('/assets/index-AbCdEf12.js');
  assert.match(script.type, /javascript/);
  assert.match(script.cache, /immutable/);
});

test('unknown paths get the game page (it is a single-page app)', async () => {
  const res = await get('/some/where');
  assert.equal(res.status, 200);
  assert.match(res.body, /<title>game<\/title>/);
});

test('files outside the game folder cannot be reached', async () => {
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt']) {
    const res = await get(path);
    assert.ok(!res.body.includes('nope'), `${path} leaked the file`);
  }
});

test('game connections work on the same port', async () => {
  const socket = new WebSocket(`ws://localhost:${server.port}`);
  const first = await new Promise<string>((resolve) => socket.once('message', (data) => resolve(data.toString())));
  assert.equal(JSON.parse(first).type, 'rooms');
  socket.close();
});

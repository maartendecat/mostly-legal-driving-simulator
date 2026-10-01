import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NO_INPUT, TICK_DT, type GameEvent, type PlayerInput } from '@game/shared';
// End-to-end: the real client session against a real server, in one process.
import { GameServer } from '../../server/src/GameServer';
import { NetworkSession } from '../src/session/NetworkSession';

let server: GameServer;
let url: string;

before(async () => {
  server = new GameServer({ port: 0, seed: 1234 });
  await server.listening();
  url = `ws://localhost:${server.port}`;
});

after(() => server.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs client frames in real time (one tick per frame), collecting the events each frame shows. */
async function play(sessions: NetworkSession[], ms: number, input: (s: NetworkSession) => PlayerInput = () => NO_INPUT) {
  const events = new Map<NetworkSession, GameEvent[]>(sessions.map((s) => [s, []]));
  const end = performance.now() + ms;
  while (performance.now() < end) {
    for (const session of sessions) events.get(session)!.push(...session.update(TICK_DT, () => input(session)).events);
    await sleep(TICK_DT * 1000);
  }
  return events;
}

/**
 * Puts a player close by (on the same road, 10 blocks south): players only get what's around them,
 * so to see someone's bullets you have to be near them.
 */
async function standNearby(session: NetworkSession) {
  Object.assign(server.world.peds.get(session.myPedId)!, { x: 2.5, y: 20.5 });
  await play([session], 150);
}

/** Arms a player on the server and puts them in the centre lane of the westernmost road. */
async function armOnServer(session: NetworkSession, heading: number) {
  const ped = server.world.peds.get(session.myPedId)!;
  Object.assign(ped, { x: 2.5, y: 30.5, heading, weapon: 'pistol', ammo: { pistol: 10 }, fireCooldown: 0 });
  // Let the client catch up with the change before it starts predicting from it.
  await play([session], 150);
  assert.equal(session.world.peds.get(session.myPedId)?.weapon, 'pistol');
}

const ownProjectiles = (session: NetworkSession, ownerId: number) =>
  [...session.world.projectiles.values()].filter((p) => p.ownerId === ownerId);

test('your own shots appear instantly, exactly once, and other players see them too', async () => {
  const alice = await NetworkSession.connect(url, { name: 'Alice', lagMs: 150 });
  const bob = await NetworkSession.connect(url, { name: 'Bob' });
  await armOnServer(alice, Math.PI / 2); // north, along the empty road
  await standNearby(bob);

  // One frame with fire held: the bullet is there straight away, although the server can't have
  // seen the input yet (150 ms simulated lag).
  alice.update(TICK_DT, () => ({ ...NO_INPUT, fire: true }));
  assert.equal(ownProjectiles(alice, alice.myPedId).length, 1, 'predicted bullet should appear at once');

  let bobSawIt = false;
  const end = performance.now() + 500;
  while (performance.now() < end) {
    alice.update(TICK_DT, () => NO_INPUT);
    bob.update(TICK_DT, () => NO_INPUT);
    assert.ok(ownProjectiles(alice, alice.myPedId).length <= 1, 'the bullet must not be drawn twice (predicted + server)');
    if (ownProjectiles(bob, alice.myPedId).length > 0) bobSawIt = true;
    await sleep(TICK_DT * 1000);
  }
  assert.ok(bobSawIt, "Bob should see Alice's bullet");
  assert.equal(server.world.peds.get(alice.myPedId)!.ammo.pistol, 9, 'the server fired exactly one shot');
  alice.close();
  bob.close();
});

test('impacts reach both players: the shooter at once, others in step with what they draw', async () => {
  const alice = await NetworkSession.connect(url, { name: 'Alice' });
  const bob = await NetworkSession.connect(url, { name: 'Bob' });
  await armOnServer(alice, Math.PI); // west, into the city's edge wall 1.5 blocks away
  await standNearby(bob);

  alice.update(TICK_DT, () => ({ ...NO_INPUT, fire: true }));
  const events = await play([alice, bob], 500);
  const impacts = (s: NetworkSession) => events.get(s)!.filter((e) => e.type === 'impact' && e.ownerId === alice.myPedId);
  assert.equal(impacts(alice).length, 1);
  assert.equal(impacts(bob).length, 1);
  alice.close();
  bob.close();
});

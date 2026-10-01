import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureSnapshot, createWorld, generateCity, spawnCar, spawnPed, startTraffic, type GameEvent } from '@game/shared';
import { forClients, viewFor, visibleEvents, visibleSnapshot } from '../src/interest';

function city() {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  const me = spawnPed(world, 10.5, 10.5);
  const friend = spawnPed(world, 70.5, 70.5);
  return { world, me, friend, players: new Set([me.id, friend.id]) };
}

test('you get the cars and bullets around you, not those across the city', () => {
  const { world, me, players } = city();
  const near = spawnCar(world, 'sedan', 14.5, 12.5, 0);
  const far = spawnCar(world, 'sedan', 60.5, 60.5, 0);
  const snapshot = visibleSnapshot(captureSnapshot(world), viewFor(world, me.id), players);
  assert.deepEqual(snapshot.cars.map((c) => c.id), [near.id]);
  assert.ok(!snapshot.cars.some((c) => c.id === far.id));
});

test('other players, and the cars they drive, are always included (for arrows and name tags)', () => {
  const { world, me, friend, players } = city();
  const theirCar = spawnCar(world, 'sports', friend.x, friend.y, 0);
  theirCar.driverId = friend.id;
  friend.carId = theirCar.id;
  const snapshot = visibleSnapshot(captureSnapshot(world), viewFor(world, me.id), players);
  assert.ok(snapshot.peds.some((p) => p.id === friend.id));
  assert.ok(snapshot.cars.some((c) => c.id === theirCar.id));
  assert.equal(snapshot.pickups.length, world.pickups.size, 'all pickups');
});

test('you see further while driving fast (the camera zooms out)', () => {
  const { world, me } = city();
  const onFoot = viewFor(world, me.id)!.radius;
  const car = spawnCar(world, 'sports', me.x, me.y, 0);
  car.driverId = me.id;
  me.carId = car.id;
  car.vx = 18;
  assert.ok(viewFor(world, me.id)!.radius > onFoot + 10);
});

test("players' deaths and wrecks reach everyone; a gang's grudge its target; pedestrians' deaths, sparks and explosions only those nearby", () => {
  const { world, me, players } = city();
  const at = (x: number, y: number) => ({ tick: 1, ownerId: 1, x, y });
  const events: GameEvent[] = [
    { type: 'impact', ...at(12, 12) },
    { type: 'impact', ...at(60, 60) },
    { type: 'explosion', ...at(60, 60), radius: 2 },
    { type: 'death', ...at(60, 60), pedId: [...players][1]!, killerId: 1, cause: 'pistol' },
    { type: 'death', ...at(61, 61), pedId: 999, killerId: 1, cause: 'pistol' }, // a pedestrian, far away
    { type: 'death', ...at(13, 13), pedId: 998, killerId: 1, cause: 'pistol' }, // a pedestrian, nearby
    { type: 'carDestroyed', ...at(60, 60), carId: 3, attackerId: 1 },
    { type: 'gangAngry', ...at(62, 62), gang: 1, pedId: me.id }, // after me, wherever it happened
    { type: 'gangAngry', ...at(12, 12), gang: 2, pedId: [...players][1]! }, // after someone else
    { type: 'wanted', ...at(63, 63), pedId: me.id, level: 1 },
    { type: 'wanted', ...at(12, 12), pedId: [...players][1]!, level: 1 },
    { type: 'busted', ...at(64, 64), pedId: [...players][1]!, copId: 5 },
  ];
  assert.deepEqual(
    visibleEvents(events, viewFor(world, me.id), players, me.id).map((e) => `${e.type}@${e.x}`),
    ['impact@12', 'death@60', 'death@13', 'carDestroyed@60', 'gangAngry@62', 'wanted@63', 'busted@64'],
  );
});

test("traffic cars' driving state stays on the server", () => {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  const car = spawnCar(world, 'sedan', 5.5, 1.5, 0);
  startTraffic(world, car);
  const sent = forClients(captureSnapshot(world));
  assert.equal(sent.cars[0]!.traffic, null);
  assert.ok(car.traffic, 'the real car keeps driving');
});

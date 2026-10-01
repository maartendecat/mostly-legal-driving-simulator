import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Block,
  CORPSE_TICKS,
  DEFAULT_MATCH_SETTINGS,
  Match,
  NO_INPUT,
  POINTS,
  canPickUpWeapons,
  cloneWorld,
  createWorld,
  damagePed,
  generateCity,
  isPedestrian,
  pedCollides,
  secondsToTicks,
  spawnCar,
  spawnPed,
  spawnPedestrian,
  spawnPickup,
  stepWorld,
  type Ped,
  type World,
} from '../src/index';

const pedestrians = (world: World) => [...world.peds.values()].filter((p) => isPedestrian(p) && p.respawnAt === null);
const run = (world: World, ticks: number, each?: () => void) => {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    each?.();
  }
};
const kindUnder = (world: World, p: Ped) => world.map.kinds[Math.floor(p.y) * world.map.width + Math.floor(p.x)];

/** A quiet city with one pedestrian on the pavement south of the first block (row y=4). */
function onePedestrian(): { world: World; ped: Ped } {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  world.pickups.clear();
  assert.equal(world.map.kinds[4 * world.map.width + 8], Block.Pavement);
  return { world, ped: spawnPedestrian(world, 8, 4) };
}

test('a pedestrian strolls along the pavements on their own, and never into a wall', () => {
  const { world, ped } = onePedestrian();
  let onPavement = 0;
  let samples = 0;
  let walked = 0;
  let last = { x: ped.x, y: ped.y };
  run(world, secondsToTicks(60), () => {
    samples++;
    if (kindUnder(world, ped) === Block.Pavement) onPavement++;
    assert.ok(!pedCollides(world.map, ped.x, ped.y), 'inside a wall');
    walked += Math.hypot(ped.x - last.x, ped.y - last.y);
    last = { x: ped.x, y: ped.y };
  });
  assert.ok(onPavement / samples > 0.85, `on the pavement ${((100 * onPavement) / samples).toFixed(0)}% of the time`);
  assert.ok(walked > 40, `walked ${walked.toFixed(0)} blocks in a minute`);
  assert.ok(walked < 60 * 2.3, 'at a stroll, not a run');
});

test('gunfire nearby makes pedestrians run away; far away it does not bother them', () => {
  const { world, ped } = onePedestrian();
  const faraway = spawnPedestrian(world, 60, 4);
  run(world, 30);
  const shooter = spawnPed(world, 8.5, 2.5);
  Object.assign(shooter, { heading: 0, weapon: 'pistol', ammo: { pistol: 5 } });
  stepWorld(world, new Map([[shooter.id, { ...NO_INPUT, fire: true }]]));
  run(world, 20);
  assert.ok(ped.ai!.panicTicks > 0, 'panicking');
  assert.ok(faraway.ai!.panicTicks === 0, 'too far away to care');
  // Running, not strolling: well over a block in half a second.
  const running = { x: ped.x, y: ped.y };
  run(world, 30);
  const ran = Math.hypot(ped.x - running.x, ped.y - running.y);
  assert.ok(ran > 1.2, `ran ${ran.toFixed(1)} blocks in half a second (strolling would be 0.7)`);
});

test('a car speeding at a pedestrian makes them jump out of its way', () => {
  const { world, ped } = onePedestrian();
  // On the pavement row y=4, facing it: a car coming fast along the pavement, straight at them.
  const car = spawnCar(world, 'sports', ped.x - 4, ped.y, 0);
  car.vx = 10;
  run(world, 40);
  assert.equal(ped.health, 100, 'dodged');
});

test('pedestrians can be shot; bodies stay for a while, then make way for new pedestrians out of sight', () => {
  const world = createWorld(generateCity(2), 2, { pedestrians: 12 });
  const player = spawnPed(world, 40.5, 40.5);
  run(world, 30);
  assert.equal(pedestrians(world).length, 12);
  for (const p of pedestrians(world)) assert.ok(Math.hypot(p.x - player.x, p.y - player.y) >= 14, 'appeared out of sight');

  const victim = pedestrians(world)[0]!;
  damagePed(world, victim, 100, player.id, 'pistol');
  run(world, 5);
  assert.ok(world.peds.has(victim.id), 'the body is still there');
  assert.equal(pedestrians(world).length, 12, 'and someone else is already walking around');
  run(world, CORPSE_TICKS);
  assert.ok(!world.peds.has(victim.id), 'body cleared away');
});

test('pedestrians are not players: no weapons, no frags, a few points', () => {
  const { world, ped } = onePedestrian();
  assert.equal(canPickUpWeapons(world, ped), false);
  spawnPickup(world, 'pistol', ped.x, ped.y);
  run(world, 2);
  assert.equal(ped.weapon, null);

  const match = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: ['points'] }, world);
  const player = spawnPed(world, 20.5, 4.5);
  match.addPlayer(world, player.id);
  world.events = [{ type: 'death', tick: 0, ownerId: player.id, pedId: ped.id, killerId: player.id, cause: 'pistol', x: 0, y: 0 }];
  match.update(world);
  assert.deepEqual(match.scores.get(player.id), { frags: 0, deaths: 0, points: POINTS.pedestrian, itTicks: 0 });
});

test('a full city: traffic and pedestrians get along', () => {
  const world = createWorld(generateCity(3), 3, { traffic: 16, pedestrians: 40 });
  let runOver = 0;
  run(world, secondsToTicks(120), () => {
    for (const e of world.events) if (e.type === 'death') runOver++;
  });
  assert.equal(pedestrians(world).length, 40);
  assert.ok(runOver <= 2, `${runOver} pedestrians run over by traffic in 2 minutes`);
});

test('pedestrians replay identically, so prediction agrees with the server', () => {
  const world = createWorld(generateCity(5), 5, { traffic: 8, pedestrians: 20 });
  run(world, 200);
  const copy = cloneWorld(world);
  run(world, 300);
  run(copy, 300);
  assert.deepEqual([...copy.peds.values()], [...world.peds.values()]);
  assert.equal(copy.rngState, world.rngState);
});

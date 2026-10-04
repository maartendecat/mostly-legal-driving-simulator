import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO_INPUT,
  WEAPONS,
  cloneWorld,
  createWorld,
  generateCity,
  isPickupAvailable,
  isSolidAt,
  secondsToTicks,
  spawnCar,
  spawnPed,
  spawnPickup,
  stepWorld,
  type GameEvent,
  type Ped,
  type PlayerInput,
  type WeaponId,
  type World,
} from '../src/index';

/**
 * Cell column x=2 is the centre lane of the westernmost north-south road, so a ped at x=2.5 can
 * shoot north along an empty road, or west into the city's edge wall (which starts at x=1).
 */
const LANE_X = 2.5;
const START_Y = 30.5;
const NORTH = Math.PI / 2;
const WEST = Math.PI;

/** A world without cars or pickups, so nothing gets in the way unless a test adds it. */
function emptyWorld(): World {
  const world = createWorld(generateCity(1, 6), 1);
  world.cars.clear();
  world.pickups.clear();
  return world;
}

function armedPed(world: World, weapon: WeaponId, ammo: number, heading: number, x = LANE_X, y = START_Y): Ped {
  const ped = spawnPed(world, x, y);
  ped.heading = heading;
  ped.weapon = weapon;
  ped.ammo[weapon] = ammo;
  return ped;
}

function input(overrides: Partial<PlayerInput>): PlayerInput {
  return { ...NO_INPUT, ...overrides };
}

/** Steps the world `ticks` times with the same input for one ped, collecting all events. */
function run(world: World, pedId: number, ticks: number, playerInput: PlayerInput = NO_INPUT): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map([[pedId, playerInput]]));
    events.push(...world.events);
  }
  return events;
}

test('firing shoots a projectile the way the ped faces, uses ammo and respects the fire rate', () => {
  const world = emptyWorld();
  const ped = armedPed(world, 'pistol', 10, NORTH);

  run(world, ped.id, 1, input({ fire: true }));
  const [bullet] = [...world.projectiles.values()];
  assert.ok(bullet, 'a bullet should be in flight');
  assert.equal(bullet.ownerId, ped.id);
  assert.ok(bullet.y > ped.y && Math.abs(bullet.x - LANE_X) < 0.05, 'bullet should fly north');

  // Holding fire for a second: shots at ticks 0, 18, 36 and 54.
  run(world, ped.id, 59, input({ fire: true }));
  assert.equal(ped.ammo.pistol, 10 - 4);
});

test('bullets stop at walls with an impact, and never fly through them', () => {
  const world = emptyWorld();
  const ped = armedPed(world, 'machineGun', 50, WEST);
  const events: GameEvent[] = [];
  for (let i = 0; i < 120; i++) {
    stepWorld(world, new Map([[ped.id, input({ fire: i < 30 })]]));
    events.push(...world.events);
    for (const p of world.projectiles.values()) assert.ok(!isSolidAt(world.map, p.x, p.y), 'projectile inside a wall');
  }
  const impacts = events.filter((e) => e.type === 'impact');
  assert.equal(impacts.length, 6, 'all six shots should hit the wall');
  for (const impact of impacts) assert.ok(impact.x > 0.9 && impact.x < 1.05, `impact at x=${impact.x}`);
  assert.equal(world.projectiles.size, 0);
});

test('rockets explode where they hit', () => {
  const world = emptyWorld();
  const ped = armedPed(world, 'rocketLauncher', 3, WEST);
  const events = [...run(world, ped.id, 1, input({ fire: true })), ...run(world, ped.id, 60)];
  const explosions = events.filter((e) => e.type === 'explosion');
  assert.equal(explosions.length, 1);
  assert.equal(explosions[0]!.type === 'explosion' && explosions[0]!.radius, WEAPONS.rocketLauncher.blastRadius);
  assert.ok(explosions[0]!.x < 1.05);
});

test('bullets hit other peds and cars', () => {
  const world = emptyWorld();
  const shooter = armedPed(world, 'pistol', 10, NORTH);
  spawnPed(world, LANE_X, START_Y + 3);
  let events = run(world, shooter.id, 30, input({ fire: true }));
  const pedHit = events.find((e) => e.type === 'impact')!;
  assert.ok(Math.abs(pedHit.y - (START_Y + 3)) < 0.3, `should hit the ped, hit at y=${pedHit.y}`);

  const other = emptyWorld();
  const gunner = armedPed(other, 'pistol', 10, NORTH);
  spawnCar(other, 'sedan', LANE_X, START_Y + 4, 0);
  events = run(other, gunner.id, 30, input({ fire: true }));
  const carHit = events.find((e) => e.type === 'impact')!;
  assert.ok(Math.abs(carHit.y - (START_Y + 4 - 0.275)) < 0.2, `should hit the car's side, hit at y=${carHit.y}`);
});

test('you cannot shoot from inside a car', () => {
  const world = emptyWorld();
  const car = spawnCar(world, 'sedan', LANE_X, START_Y, NORTH);
  const ped = armedPed(world, 'pistol', 10, NORTH, LANE_X, START_Y);
  run(world, ped.id, 1, input({ enter: true }));
  assert.equal(ped.carId, car.id);
  run(world, ped.id, 30, input({ fire: true }));
  assert.equal(world.projectiles.size, 0);
  assert.equal(ped.ammo.pistol, 10);
});

test('walking over a pickup gives ammo and a weapon; it comes back after 10 seconds', () => {
  const world = emptyWorld();
  const pickup = spawnPickup(world, 'machineGun', LANE_X, START_Y + 1);
  const ped = spawnPed(world, LANE_X, START_Y);
  ped.heading = NORTH;

  // Walk over it and on, so we're not standing on it when it comes back.
  run(world, ped.id, 40, input({ up: true }));
  assert.equal(ped.weapon, 'machineGun');
  assert.equal(ped.ammo.machineGun, WEAPONS.machineGun.pickupAmmo);
  assert.ok(!isPickupAvailable(world, pickup));

  run(world, ped.id, secondsToTicks(10));
  assert.ok(isPickupAvailable(world, pickup));
});

test('a pickup stays put when the ped cannot carry more of that ammo', () => {
  const world = emptyWorld();
  const pickup = spawnPickup(world, 'pistol', LANE_X, START_Y);
  const ped = armedPed(world, 'pistol', WEAPONS.pistol.maxAmmo, NORTH);
  run(world, ped.id, 5);
  assert.ok(isPickupAvailable(world, pickup));
  assert.equal(ped.ammo.pistol, WEAPONS.pistol.maxAmmo);
});

test('weapon switching cycles through weapons that have ammo, once per key press', () => {
  const world = emptyWorld();
  const ped = armedPed(world, 'pistol', 5, NORTH);
  ped.ammo.rocketLauncher = 2;

  run(world, ped.id, 10, input({ weaponNext: true })); // held for 10 ticks: switches once
  assert.equal(ped.weapon, 'rocketLauncher');
  run(world, ped.id, 1);
  run(world, ped.id, 1, input({ weaponNext: true }));
  assert.equal(ped.weapon, 'pistol', 'wraps around, skipping the machine gun (no ammo)');
  run(world, ped.id, 1);
  run(world, ped.id, 1, input({ weaponPrev: true }));
  assert.equal(ped.weapon, 'rocketLauncher');
});

test('running out of ammo switches to the next weapon, then to unarmed', () => {
  const world = emptyWorld();
  const ped = armedPed(world, 'rocketLauncher', 1, WEST);
  ped.ammo.pistol = 1;
  run(world, ped.id, 1, input({ fire: true }));
  assert.equal(ped.weapon, 'pistol');
  run(world, ped.id, 60, input({ fire: true }));
  assert.equal(ped.weapon, null);
  assert.equal(ped.ammo.pistol, 0);
});

test('shooting is deterministic, so the server and a predicting client agree on every bullet', () => {
  const world = emptyWorld();
  const a = armedPed(world, 'machineGun', 100, NORTH);
  // Facing each other from further apart than a bullet flies, so plenty of bullets are in flight.
  const b = armedPed(world, 'machineGun', 100, -NORTH, LANE_X, START_Y + 30);
  const script = (tick: number) =>
    new Map([
      // Both sway a little left and right while firing, so the machine gun spread and turning are exercised.
      [a.id, input({ fire: true, left: tick % 40 < 4, right: tick % 40 >= 20 && tick % 40 < 24 })],
      [b.id, input({ fire: tick % 20 < 15, right: tick % 30 < 3, left: tick % 30 >= 15 && tick % 30 < 18 })],
    ]);

  let copy: World | undefined;
  for (let tick = 0; tick < 90; tick++) {
    if (tick === 40) copy = cloneWorld(world);
    stepWorld(world, script(tick));
  }
  for (let tick = 40; tick < 90; tick++) stepWorld(copy!, script(tick));

  assert.ok(world.projectiles.size > 3, 'there should be bullets in flight');
  assert.deepEqual([...copy!.projectiles.values()], [...world.projectiles.values()]);
  assert.deepEqual([...copy!.peds.values()], [...world.peds.values()]);
  assert.deepEqual(copy!.events, world.events);
});

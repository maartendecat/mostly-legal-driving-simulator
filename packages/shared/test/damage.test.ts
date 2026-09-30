import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAR_BURN_TICKS,
  NO_INPUT,
  ROCKET_CAR_FUSE_TICKS,
  PED_MAX_HEALTH,
  RESPAWN_TICKS,
  WRECK_TICKS,
  cloneWorld,
  createWorld,
  damageCar,
  damagePed,
  generateCity,
  isDead,
  spawnCar,
  spawnPed,
  stepWorld,
  type Car,
  type GameEvent,
  type Ped,
  type PlayerInput,
  type WeaponId,
  type World,
} from '../src/index';

/**
 * Column x=2 is the centre lane of the westernmost north-south road (cells x=1..3 are road, x=4 is
 * pavement), so everything here happens in a straight, open strip running north from y≈28.
 */
const LANE_X = 2.5;
const NORTH = Math.PI / 2;

function emptyWorld(): World {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  world.pickups.clear();
  return world;
}

function pedAt(world: World, x: number, y: number, heading = NORTH, weapon?: WeaponId, ammo = 100): Ped {
  const ped = spawnPed(world, x, y);
  ped.heading = heading;
  if (weapon) {
    ped.weapon = weapon;
    ped.ammo[weapon] = ammo;
  }
  return ped;
}

function input(overrides: Partial<PlayerInput>): PlayerInput {
  return { ...NO_INPUT, ...overrides };
}

/** Steps `ticks` times; `inputs` gives each ped's input per tick. Returns all events. */
function run(world: World, ticks: number, inputs: Record<number, PlayerInput> = {}): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map(Object.entries(inputs).map(([id, value]) => [Number(id), value])));
    events.push(...world.events);
  }
  return events;
}

const deaths = (events: GameEvent[]) => events.filter((e): e is Extract<GameEvent, { type: 'death' }> => e.type === 'death');

function driveInto(world: World, ped: Ped, car: Car): void {
  ped.x = car.x;
  ped.y = car.y;
  run(world, 1, { [ped.id]: input({ enter: true }) });
  assert.equal(ped.carId, car.id);
}

test('four pistol hits kill; the kill is credited, weapons drop and the victim comes back 3 s later', () => {
  const world = emptyWorld();
  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'pistol', 10);
  const victim = pedAt(world, LANE_X, 33.5, NORTH, 'machineGun', 50);

  const events = run(world, 90, { [shooter.id]: input({ fire: true }) });
  const [death] = deaths(events);
  assert.ok(death, 'victim should die');
  assert.equal(death.pedId, victim.id);
  assert.equal(death.killerId, shooter.id);
  assert.equal(death.cause, 'pistol');
  assert.equal(10 - shooter.ammo.pistol!, 5, 'four hits to kill, plus one shot that was already on its way');
  assert.ok(isDead(victim));
  assert.equal(victim.weapon, null);
  assert.deepEqual(victim.ammo, {});

  run(world, RESPAWN_TICKS);
  assert.ok(!isDead(victim));
  assert.equal(victim.health, PED_MAX_HEALTH);
  assert.ok(world.map.pedSpawns.some((s) => s.x === victim.x && s.y === victim.y), 'respawns at a spawn point');
});

test('the dead cannot move, shoot, or be shot again', () => {
  const world = emptyWorld();
  const victim = pedAt(world, LANE_X, 33.5, NORTH, 'pistol', 10);
  damagePed(world, victim, PED_MAX_HEALTH, null, 'runOver');
  const where = { x: victim.x, y: victim.y };

  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'pistol', 10);
  const events = run(world, 60, { [victim.id]: input({ up: true, fire: true }), [shooter.id]: input({ fire: true }) });
  assert.deepEqual({ x: victim.x, y: victim.y }, where);
  assert.ok([...world.projectiles.values()].every((p) => p.ownerId !== victim.id));
  assert.equal(deaths(events).length, 0, 'bullets pass over the body');
});

test('a rocket blast hurts less further from the centre, and not at all beyond its radius', () => {
  const world = emptyWorld();
  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'rocketLauncher', 1);
  const target = pedAt(world, LANE_X, 36.5);
  const near = pedAt(world, 3.5, 37.2);
  const far = pedAt(world, 3.5, 39.5);

  const events = [...run(world, 1, { [shooter.id]: input({ fire: true }) }), ...run(world, 60)];
  assert.ok(isDead(target), 'a direct hit kills');
  assert.ok(near.health > 0 && near.health < PED_MAX_HEALTH, `near health ${near.health}`);
  assert.equal(far.health, PED_MAX_HEALTH);
  assert.equal(deaths(events)[0]?.cause, 'rocketLauncher');
});

test('running someone over at speed kills them and credits the driver; a gentle nudge does not', () => {
  const world = emptyWorld();
  const driver = pedAt(world, LANE_X, 20);
  const car = spawnCar(world, 'sports', LANE_X, 20.5, NORTH);
  driveInto(world, driver, car);
  const victim = pedAt(world, LANE_X, 33);

  const events = run(world, 120, { [driver.id]: input({ up: true }) });
  const [death] = deaths(events);
  assert.ok(death, 'victim should be run over');
  assert.equal(death.pedId, victim.id);
  assert.equal(death.cause, 'runOver');
  assert.equal(death.killerId, driver.id);

  const calm = emptyWorld();
  const rolling = spawnCar(calm, 'sedan', LANE_X, 31.5, NORTH);
  rolling.vy = 2;
  const bystander = pedAt(calm, LANE_X, 32.4);
  run(calm, 60);
  assert.equal(bystander.health, PED_MAX_HEALTH);
});

test('a car shot to pieces burns, then explodes: the driver dies, bystanders get hurt, a wreck remains', () => {
  const world = emptyWorld();
  const car = spawnCar(world, 'sedan', LANE_X, 34.5, 0);
  const driver = pedAt(world, LANE_X, 34.5);
  driveInto(world, driver, car);
  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'machineGun', 100);
  const bystander = pedAt(world, 4.5, 34.5);

  let events = run(world, 150, { [shooter.id]: input({ fire: true }) });
  assert.equal(car.health, 0);
  assert.ok(car.explodeAt !== null && !car.wrecked, 'burning, not yet exploded');
  assert.ok(!isDead(driver), 'still time to get out');

  events = run(world, CAR_BURN_TICKS);
  assert.ok(car.wrecked);
  assert.ok(events.some((e) => e.type === 'explosion'));
  const driverDeath = deaths(events).find((d) => d.pedId === driver.id);
  assert.equal(driverDeath?.cause, 'carExplosion');
  assert.equal(driverDeath?.killerId, shooter.id, 'whoever wrecked the car gets the credit');
  assert.ok(bystander.health > 0 && bystander.health < PED_MAX_HEALTH, `bystander health ${bystander.health}`);
  assert.equal(shooter.health, PED_MAX_HEALTH, 'the shooter was out of range');
});

test('a car destroyed by a rocket explodes a moment after the rocket; cars caught in that burn first', () => {
  const world = emptyWorld();
  const car = spawnCar(world, 'sedan', LANE_X, 36.5, 0);
  const driver = pedAt(world, LANE_X, 36.5);
  driveInto(world, driver, car);
  // Parked 2 blocks away: inside the car's explosion radius, outside the rocket's.
  const neighbour = spawnCar(world, 'compact', LANE_X, 38.5, 0);
  neighbour.health = 10;
  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'rocketLauncher', 1);

  const events = [...run(world, 1, { [shooter.id]: input({ fire: true }) }), ...run(world, 60)];
  assert.ok(car.wrecked, 'no long burning phase for a rocket hit');
  const [rocketBlast, carBlast, ...rest] = events.filter((e) => e.type === 'explosion');
  assert.ok(rocketBlast && carBlast && rest.length === 0, 'the rocket, then the car');
  assert.equal(carBlast.tick - rocketBlast.tick, ROCKET_CAR_FUSE_TICKS, 'two separate booms, 0.3 s apart');
  const driverDeath = deaths(events).find((d) => d.pedId === driver.id);
  assert.equal(driverDeath?.cause, 'carExplosion');
  assert.equal(driverDeath?.killerId, shooter.id);
  assert.ok(!neighbour.wrecked && neighbour.explodeAt !== null, 'the neighbour caught fire and will blow later');
});

test('a rocket finishes off a car that is already burning', () => {
  const world = emptyWorld();
  const car = spawnCar(world, 'sedan', LANE_X, 36.5, 0);
  damageCar(world, car, 1000, null);
  assert.ok(car.explodeAt !== null && !car.wrecked);
  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'rocketLauncher', 1);
  run(world, 1, { [shooter.id]: input({ fire: true }) });
  run(world, 60); // about 1 s, well short of the 3 s burn
  assert.ok(car.wrecked, 'the rocket should have blown it up before the fire did');
});

test('wrecks cannot be driven or entered, and make way for a fresh car after 30 s', () => {
  const world = emptyWorld();
  const car = spawnCar(world, 'sedan', LANE_X, 34.5, NORTH);
  damageCar(world, car, 1000, null);
  run(world, CAR_BURN_TICKS + 1);
  assert.ok(car.wrecked);

  const ped = pedAt(world, LANE_X + 0.6, 34.5);
  run(world, 1, { [ped.id]: input({ enter: true }) });
  assert.equal(ped.carId, null);

  run(world, WRECK_TICKS);
  assert.ok(!world.cars.has(car.id), 'wreck cleared away');
  assert.equal(world.cars.size, 1, 'replaced by a new car');
  assert.ok(![...world.cars.values()][0]!.wrecked);
});

test('crashing into a wall at speed damages the car; parking against it does not', () => {
  const world = emptyWorld();
  // West along the east-west road at y≈26.5, into the city's west wall.
  const car = spawnCar(world, 'sports', 30.5, 26.5, Math.PI);
  const driver = pedAt(world, 30.5, 26.5);
  driveInto(world, driver, car);
  run(world, 180, { [driver.id]: input({ up: true }) });
  assert.ok(car.health < 90, `health ${car.health}`);

  const calm = emptyWorld();
  const parked = spawnCar(calm, 'sports', 2.2, 26.5, Math.PI);
  parked.vx = -2;
  run(calm, 60);
  assert.equal(parked.health, 90);
});

test('deaths and respawns replay identically, so prediction stays in sync with the server', () => {
  const world = emptyWorld();
  const shooter = pedAt(world, LANE_X, 30.5, NORTH, 'machineGun', 300);
  const victim = pedAt(world, LANE_X, 33.5);
  const script = { [shooter.id]: input({ fire: true }) };

  run(world, 90, script); // nine machine gun hits
  assert.ok(isDead(victim), 'the victim should be dead before we copy the world');
  const copy = cloneWorld(world);
  run(world, RESPAWN_TICKS + 30, script);
  run(copy, RESPAWN_TICKS + 30, script);
  assert.ok(!isDead(victim), 'and respawned (at a random spot) by the end');
  assert.deepEqual([...copy.peds.values()], [...world.peds.values()]);
  assert.equal(copy.rngState, world.rngState);
});

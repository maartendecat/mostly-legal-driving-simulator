import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARMY_AFTER_TICKS,
  CAR_MODELS,
  DEFAULT_MATCH_SETTINGS,
  HELICOPTER_HEALTH,
  Match,
  NO_INPUT,
  POINTS,
  WANTED_LEVEL_HEAT,
  cloneWorld,
  createWorld,
  damagePed,
  generateCity,
  placeRoadblock,
  reportCrime,
  secondsToTicks,
  spawnCar,
  spawnHelicopter,
  spawnPed,
  spawnPedestrian,
  spawnProjectile,
  startTraffic,
  stepWorld,
  type Car,
  type Ped,
  type PlayerInput,
  type World,
} from '../src/index';

const run = (world: World, ticks: number, inputs: ReadonlyMap<number, PlayerInput> = new Map(), each?: () => void) => {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, inputs);
    each?.();
  }
};

/** A quiet city (no traffic, no pickups) with a player standing on the pavement at (12.5, 4.5). */
function quiet(seed = 1): { world: World; player: Ped } {
  const world = createWorld(generateCity(seed, 6), seed);
  world.cars.clear();
  world.pickups.clear();
  return { world, player: spawnPed(world, 12.5, 4.5) };
}

/** Makes a player wanted at exactly `level` stars, and keeps them there. */
function wantedAt(world: World, player: Ped, level: number): () => void {
  reportCrime(world, player.id, 'killCop');
  const hold = () => {
    const record = world.wanted.find((w) => w.pedId === player.id);
    if (record) record.heat = WANTED_LEVEL_HEAT[level]!;
    player.wanted = level;
  };
  hold();
  return hold;
}

/** A full city with a player kept at `level` stars (and alive), for `seconds`. */
function chase(level: number, seconds: number, seed = 2) {
  const world = createWorld(generateCity(seed, 6), seed, { traffic: 8, policeCars: 2, cops: 4 });
  run(world, 120);
  const player = spawnPed(world);
  const hold = wantedAt(world, player, level);
  const seen = { models: new Set<string>(), kinds: new Set<string>(), helicopters: 0, shotsBy: new Set<string>() };
  run(world, secondsToTicks(seconds), new Map(), () => {
    Object.assign(player, { health: 100, respawnAt: null });
    hold();
    for (const car of world.cars.values()) if (car.police && car.traffic) seen.models.add(car.model);
    for (const ped of world.peds.values()) seen.kinds.add(ped.kind);
    seen.helicopters = Math.max(seen.helicopters, world.helicopters.size);
    for (const p of world.projectiles.values()) {
      const owner = world.peds.get(p.ownerId)?.kind ?? world.cars.get(p.ownerId)?.model ?? (world.helicopters.has(p.ownerId) ? 'helicopter' : '');
      if (owner) seen.shotsBy.add(owner);
    }
  });
  return { world, player, seen };
}

test('heavier cars push lighter ones aside, and a tank crushes a car it pins', () => {
  const { world } = quiet();
  // Driving into a sedan on an open road: it's shoved along, the tank hardly notices.
  const tank = spawnCar(world, 'tank', 20.5, 2.5, 0);
  const sedan = spawnCar(world, 'sedan', 21.9, 2.5, 0);
  run(world, 20, new Map(), () => (tank.vx = 4));
  assert.ok(sedan.x > 22.3, `the sedan was pushed along (${sedan.x.toFixed(2)})`);
  assert.ok(tank.vx > 3, 'the tank hardly noticed');

  // Pinning one against the city wall (the south side of the first road): crushed.
  const pinned = spawnCar(world, 'sedan', 40.5, 1.35, 0);
  const crusher = spawnCar(world, 'tank', 40.5, 2.55, -Math.PI / 2);
  run(world, 60, new Map(), () => (crusher.vy = -2));
  assert.ok(pinned.health < CAR_MODELS.sedan.health - 50, `crushed (${pinned.health.toFixed(0)} health left)`);
  assert.equal(crusher.health, CAR_MODELS.tank.health);
});

test('armour: bullets barely scratch a tank, and do little to a SWAT van', () => {
  const { world, player } = quiet();
  for (const [model, share] of [['sedan', 1], ['swatVan', 0.3], ['tank', 0.1]] as const) {
    const car = spawnCar(world, model, 20.5, 1.5, 0);
    spawnProjectile(world, 'pistol', player.id, 18, 1.5, 0);
    run(world, 20);
    assert.equal(CAR_MODELS[model].health - car.health, 25 * 0.5 * share, model);
    world.cars.delete(car.id);
  }
});

test('three stars and driving fast: a roadblock ahead, out of sight, across the road', () => {
  const { world, player } = quiet();
  const car = spawnCar(world, 'sports', 4.5, 1.5, 0); // eastbound on the first road
  car.driverId = player.id;
  player.carId = car.id;
  car.vx = 8;
  wantedAt(world, player, 3);
  assert.ok(placeRoadblock(world, player, car));
  const blockade = world.roadblocks[0]!.carIds.map((id) => world.cars.get(id)!);
  assert.equal(blockade.length, 2);
  for (const police of blockade) {
    assert.ok(police.police && police.siren && police.traffic === null);
    assert.ok(police.x - car.x >= 17 && police.x - car.x <= 33, `ahead (${(police.x - car.x).toFixed(1)} blocks)`);
    assert.ok(Math.abs(Math.cos(police.heading)) < 0.01, 'parked across the road');
  }
  assert.ok(Math.abs(blockade[0]!.y - blockade[1]!.y) > 1, 'end to end, filling the road');
  const cops = [...world.peds.values()].filter((p) => p.kind === 'cop' && p.ai!.temporary);
  assert.equal(cops.length, 2, 'two cops with it');
});

test('a roadblock is cleared away once the suspect is no longer wanted that much', () => {
  const { world, player } = quiet();
  const car = spawnCar(world, 'sports', 4.5, 1.5, 0);
  car.driverId = player.id;
  player.carId = car.id;
  car.vx = 8;
  wantedAt(world, player, 3);
  placeRoadblock(world, player, car);
  const ids = world.roadblocks[0]!.carIds;
  world.wanted = [];
  player.wanted = 0;
  run(world, 5);
  assert.equal(world.roadblocks.length, 0);
  assert.ok(ids.every((id) => !world.cars.has(id)));
});

test('four stars: a SWAT van comes, pulls up, and four SWAT officers get out and shoot (no arrests)', () => {
  const { world, seen } = chase(4, 25);
  assert.ok(seen.models.has('swatVan'));
  assert.ok(seen.kinds.has('swat'));
  assert.ok(seen.shotsBy.has('swat'), 'they shoot');
  assert.ok(![...world.cars.values()].some((c) => c.model === 'tank'), 'no army yet');
});

test('six stars: the army comes, with a tank, a troop truck and a helicopter, all shooting', () => {
  const { seen } = chase(6, 30);
  for (const model of ['tank', 'armyTruck', 'swatVan']) assert.ok(seen.models.has(model), model);
  assert.ok(seen.kinds.has('soldier'));
  assert.equal(seen.helicopters, 1);
  for (const shooter of ['helicopter', 'soldier']) assert.ok(seen.shotsBy.has(shooter), `${shooter} shoots`);
});

test('a long chase at four stars calls in the army; without the army, it does not', () => {
  for (const [police, expected] of [['on', 6], ['noarmy', 4]] as const) {
    const world = createWorld(generateCity(1, 6), 1, { police });
    const player = spawnPed(world, 12.5, 4.5);
    reportCrime(world, player.id, 'killCop');
    world.wanted[0]!.heat = WANTED_LEVEL_HEAT[4];
    run(world, ARMY_AFTER_TICKS + 2, new Map(), () => {
      Object.assign(player, { health: 100, respawnAt: null });
      world.wanted[0]!.unseenTicks = 0; // (the police keep seeing them)
    });
    assert.equal(player.wanted, expected, police);
  }
});

test('the helicopter can be shot down: it spins down, explodes, and that is a big crime', () => {
  const { world, player } = quiet();
  const heli = spawnHelicopter(world, 30.5, 1.5, null);
  heli.vx = heli.vy = 0;
  Object.assign(player, { x: 22.5, y: 1.5, weapon: 'rocketLauncher', ammo: { rocketLauncher: 5 }, heading: 0 });
  stepWorld(world, new Map([[player.id, { ...NO_INPUT, fire: true }]]));
  run(world, 60, new Map(), () => {
    heli.x = 30.5;
    heli.y = 1.5;
  });
  assert.ok(heli.health < HELICOPTER_HEALTH, 'hit');
  heli.health = 1;
  spawnProjectile(world, 'pistol', player.id, 29, 1.5, 0);
  run(world, 10);
  assert.ok(heli.crashAt !== null, 'going down');
  let exploded = false;
  run(world, secondsToTicks(3), new Map(), () => (exploded ||= world.events.some((e) => e.type === 'explosion')));
  assert.ok(exploded && !world.helicopters.has(heli.id), 'crashed and exploded');
  assert.ok(player.wanted >= 3, `wanted: ${player.wanted} stars`);
});

test('a stolen tank fires its cannon straight ahead', () => {
  const { world, player } = quiet();
  const tank = spawnCar(world, 'tank', 20.5, 1.5, 0);
  tank.police = true;
  startTraffic(world, tank);
  tank.vx = 0;
  Object.assign(player, { x: 20.5, y: 2.5 });
  stepWorld(world, new Map([[player.id, { ...NO_INPUT, enter: true }]]));
  assert.equal(player.carId, tank.id);
  assert.ok([...world.peds.values()].some((p) => p.kind === 'soldier'), 'the crew got out');
  run(world, 2, new Map([[player.id, { ...NO_INPUT, fire: true }]]));
  const shells = [...world.projectiles.values()].filter((p) => p.weapon === 'tankShell' && p.ownerId === player.id);
  assert.equal(shells.length, 1, 'one shell (then it reloads)');
  assert.ok(Math.abs(shells[0]!.heading) < 0.05);
});

test('killing the police is worth points only up to three stars', () => {
  const { world, player } = quiet();
  const match = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: ['points'] }, world);
  match.addPlayer(world, player.id);
  const score = () => match.scores.get(player.id)!.points;
  for (const [stars, worth] of [[2, POINTS.cop], [5, 0]] as const) {
    const before = score();
    player.wanted = stars;
    const cop = spawnPedestrian(world, 13, 4, 'cop');
    world.events = [];
    damagePed(world, cop, 1000, player.id, 'pistol');
    player.wanted = stars;
    match.update(world);
    assert.equal(score() - before, worth, `${stars} stars`);
  }
});

test('when nobody is wanted any more, the units that came go again (out of sight)', () => {
  const { world, player } = chase(6, 15);
  world.wanted = [];
  player.wanted = 0;
  player.x = 2.5;
  player.y = 2.5;
  run(world, secondsToTicks(60));
  const heavy = (c: Car) => c.model === 'tank' || c.model === 'armyTruck' || c.model === 'swatVan';
  assert.equal([...world.cars.values()].filter(heavy).length, 0, 'no SWAT vans or army vehicles left');
  assert.equal(world.helicopters.size, 0, 'the helicopter flew off');
  assert.equal([...world.peds.values()].filter((p) => p.kind === 'swat' || p.kind === 'soldier').length, 0);
});

test('army chases replay identically', () => {
  const { world } = chase(6, 8);
  const copy = cloneWorld(world);
  run(world, 300);
  run(copy, 300);
  assert.deepEqual([...copy.cars.values()], [...world.cars.values()]);
  assert.deepEqual([...copy.helicopters.values()], [...world.helicopters.values()]);
  assert.deepEqual([...copy.peds.values()], [...world.peds.values()]);
});

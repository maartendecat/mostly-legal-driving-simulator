import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MATCH_SETTINGS,
  Match,
  NO_INPUT,
  PED_MAX_HEALTH,
  POINTS,
  createWorld,
  damageCar,
  damagePed,
  generateCity,
  isDead,
  spawnCar,
  spawnPed,
  spawnPickup,
  stepWorld,
  type DamageCause,
  type MatchMode,
  type MatchSettings,
  type Ped,
  type World,
} from '../src/index';

function settings(overrides: Partial<MatchSettings> & { mode?: MatchMode; limit?: number } = {}): MatchSettings {
  const { mode = 'frag', limit, ...rest } = overrides;
  return {
    ...DEFAULT_MATCH_SETTINGS,
    modes: [mode],
    scoreLimits: { frag: 3, points: 3000, tag: 100, ...(limit !== undefined ? { [mode]: limit } : {}) },
    timeLimitTicks: 600,
    intermissionTicks: 60,
    ...rest,
  };
}

function setup(players = 3, matchSettings = settings()): { world: World; match: Match; peds: Ped[] } {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  world.pickups.clear();
  const match = new Match(matchSettings, world);
  const peds = Array.from({ length: players }, () => spawnPed(world));
  peds.forEach((p) => match.addPlayer(world, p.id));
  return { world, match, peds };
}

/** Feeds one death to the match as if it had just happened in the world. */
function death(world: World, match: Match, victim: Ped, killer: Ped | null, cause: DamageCause = 'pistol'): void {
  world.events = [{ type: 'death', tick: world.tick, ownerId: killer?.id ?? victim.id, pedId: victim.id, killerId: killer?.id ?? null, cause, x: 0, y: 0 }];
  match.update(world);
  world.events = [];
}

/** Advances the world clock and the match by `ticks` without anyone doing anything. */
function wait(world: World, match: Match, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    match.update(world);
  }
}

// --- Frag ---------------------------------------------------------------------------------------

test('frag: a kill is +1 for the killer and a death for the victim', () => {
  const { world, match, peds: [alice, bob] } = setup();
  death(world, match, bob!, alice!);
  assert.equal(match.scores.get(alice!.id)!.frags, 1);
  assert.equal(match.scores.get(bob!.id)!.deaths, 1);
});

test('frag: killing yourself costs a frag; accidents only count as a death', () => {
  const { world, match, peds: [alice, bob] } = setup();
  death(world, match, alice!, alice!, 'rocketLauncher');
  death(world, match, bob!, null, 'runOver');
  assert.deepEqual([match.scores.get(alice!.id)!.frags, match.scores.get(alice!.id)!.deaths], [-1, 1]);
  assert.deepEqual([match.scores.get(bob!.id)!.frags, match.scores.get(bob!.id)!.deaths], [0, 1]);
});

test('frag: first to the limit wins, and deaths during the intermission do not count', () => {
  const { world, match, peds: [alice, bob, carol] } = setup();
  death(world, match, bob!, alice!);
  death(world, match, carol!, alice!);
  assert.equal(match.state.phase, 'playing');
  death(world, match, bob!, alice!);
  assert.equal(match.state.phase, 'intermission');
  assert.deepEqual(match.state.winnerIds, [alice!.id]);
  assert.equal(match.state.restartAt, world.tick + 60);

  death(world, match, alice!, bob!);
  assert.equal(match.scores.get(bob!.id)!.frags, 0);
});

test('when time runs out, the leaders win; a tie has several winners', () => {
  const { world, match, peds: [alice, bob, carol] } = setup();
  death(world, match, carol!, alice!);
  death(world, match, carol!, bob!);
  wait(world, match, 600);
  assert.equal(match.state.phase, 'intermission');
  assert.deepEqual(match.state.winnerIds.sort(), [alice!.id, bob!.id].sort());
});

test('after the intermission everyone starts fresh: scores reset, full health, unarmed, out of cars', () => {
  const { world, match, peds: [alice, bob] } = setup();
  const car = spawnCar(world, 'sedan', alice!.x, alice!.y, 0);
  Object.assign(alice!, { carId: car.id, weapon: 'pistol', ammo: { pistol: 20 }, health: 40 });
  car.driverId = alice!.id;
  for (let i = 0; i < 3; i++) death(world, match, bob!, alice!);
  assert.equal(match.state.phase, 'intermission');

  wait(world, match, 60);
  assert.equal(match.state.phase, 'playing');
  assert.deepEqual(match.state.winnerIds, []);
  assert.deepEqual(match.scores.get(alice!.id), { frags: 0, deaths: 0, points: 0, itTicks: 0 });
  assert.equal(alice!.health, PED_MAX_HEALTH);
  assert.equal(alice!.weapon, null);
  assert.equal(alice!.carId, null);
  assert.equal(car.driverId, null);
  assert.ok(!isDead(bob!));
  assert.equal(match.state.endsAt, world.tick + 600);
});

test('real kills in the simulation are scored', () => {
  const { world, match, peds: [alice, bob] } = setup(2);
  Object.assign(alice!, { x: 2.5, y: 30.5, heading: Math.PI / 2, weapon: 'pistol', ammo: { pistol: 10 } });
  Object.assign(bob!, { x: 2.5, y: 33.5 });
  for (let i = 0; i < 90; i++) {
    stepWorld(world, new Map([[alice!.id, { ...NO_INPUT, fire: true }]]));
    match.update(world);
  }
  assert.equal(match.scores.get(alice!.id)!.frags, 1);
  assert.equal(match.scores.get(bob!.id)!.deaths, 1);
});

test('without a score or time limit the match never ends', () => {
  const { world, match, peds: [alice, bob] } = setup(2, settings({ limit: 0, timeLimitTicks: 0 }));
  for (let i = 0; i < 50; i++) death(world, match, bob!, alice!);
  wait(world, match, 100);
  assert.equal(match.state.phase, 'playing');
  assert.equal(match.state.endsAt, null);
});

// --- Points -------------------------------------------------------------------------------------

test('points: kills are a big bonus, suicides cost, wrecking a car earns a little', () => {
  const { world, match, peds: [alice, bob] } = setup(2, settings({ mode: 'points' }));
  death(world, match, bob!, alice!);
  death(world, match, bob!, bob!, 'rocketLauncher');
  const car = spawnCar(world, 'compact', 40.5, 40.5, 0);
  damageCar(world, car, 1000, alice!.id, 1); // one-tick fuse
  wait(world, match, 2);
  assert.ok(car.wrecked);
  assert.equal(match.scores.get(alice!.id)!.points, POINTS.kill + POINTS.carDestroyed);
  assert.equal(match.scores.get(bob!.id)!.points, POINTS.suicide);
});

test('points: the first to the points limit wins', () => {
  const { world, match, peds: [alice, bob] } = setup(2, settings({ mode: 'points' }));
  for (let i = 0; i < 3; i++) death(world, match, bob!, alice!);
  assert.equal(match.state.phase, 'intermission');
  assert.deepEqual(match.state.winnerIds, [alice!.id]);
});

// --- Tag ----------------------------------------------------------------------------------------

test('tag: someone is "it" from the start, and their time counts only while alive', () => {
  const { world, match, peds } = setup(3, settings({ mode: 'tag' }));
  assert.ok(peds.some((p) => p.id === world.itPedId));
  const it = peds.find((p) => p.id === world.itPedId)!;

  wait(world, match, 30);
  assert.equal(match.scores.get(it.id)!.itTicks, 30);
  damagePed(world, it, PED_MAX_HEALTH, null, 'runOver');
  wait(world, match, 30);
  assert.equal(match.scores.get(it.id)!.itTicks, 30, 'no time while dead');
  assert.equal(world.itPedId, it.id, 'an accident does not pass "it" on');
});

test('tag: killing "it" makes you "it"; killing anyone else does not', () => {
  const { world, match, peds } = setup(3, settings({ mode: 'tag' }));
  const it = peds.find((p) => p.id === world.itPedId)!;
  const [hunter, bystander] = peds.filter((p) => p !== it);
  death(world, match, bystander!, hunter!);
  assert.equal(world.itPedId, it.id);
  death(world, match, it, hunter!);
  assert.equal(world.itPedId, hunter!.id);
});

test('tag: whoever is "it" longest wins; the first to the time limit ends the match', () => {
  const { world, match, peds } = setup(2, settings({ mode: 'tag', limit: 50 }));
  const first = peds.find((p) => p.id === world.itPedId)!;
  const other = peds.find((p) => p !== first)!;
  wait(world, match, 20);
  death(world, match, first, other);
  wait(world, match, 50);
  assert.equal(match.state.phase, 'intermission');
  assert.deepEqual(match.state.winnerIds, [other.id]);
});

test('tag: when "it" leaves, someone else becomes "it"', () => {
  const { world, match, peds } = setup(3, settings({ mode: 'tag' }));
  const it = world.itPedId!;
  match.removePlayer(world, it);
  world.peds.delete(it);
  assert.ok(world.itPedId !== null && world.itPedId !== it && peds.some((p) => p.id === world.itPedId));
});

test('tag: "it" cannot pick up weapons', () => {
  const { world, peds } = setup(2, settings({ mode: 'tag' }));
  const it = peds.find((p) => p.id === world.itPedId)!;
  const other = peds.find((p) => p !== it)!;
  spawnPickup(world, 'pistol', it.x, it.y);
  spawnPickup(world, 'pistol', other.x, other.y);
  stepWorld(world, new Map());
  assert.equal(it.weapon, null);
  assert.equal(other.weapon, 'pistol');
});

test('tag: a car driven by "it" takes double damage', () => {
  const { world, peds } = setup(2, settings({ mode: 'tag' }));
  const it = peds.find((p) => p.id === world.itPedId)!;
  const other = peds.find((p) => p !== it)!;
  const itsCar = spawnCar(world, 'truck', 10.5, 2.5, 0);
  const otherCar = spawnCar(world, 'truck', 20.5, 2.5, 0);
  itsCar.driverId = it.id;
  otherCar.driverId = other.id;
  damageCar(world, itsCar, 30, null);
  damageCar(world, otherCar, 30, null);
  assert.equal(180 - itsCar.health, 60);
  assert.equal(180 - otherCar.health, 30);
});

// --- Rotation -----------------------------------------------------------------------------------

test('with several modes, each new match plays the next one; "it" only exists in tag', () => {
  const { world, match, peds: [alice, bob] } = setup(2, settings({ modes: ['frag', 'tag', 'points'], timeLimitTicks: 10 }));
  const modes: MatchMode[] = [match.state.mode];
  const its: (number | null)[] = [world.itPedId];
  for (let i = 0; i < 3; i++) {
    wait(world, match, 10 + 60); // play out the time, then the intermission
    modes.push(match.state.mode);
    its.push(world.itPedId);
  }
  assert.deepEqual(modes, ['frag', 'tag', 'points', 'frag']);
  assert.equal(its[0], null);
  assert.ok(its[1] === alice!.id || its[1] === bob!.id);
  assert.equal(its[2], null);
});

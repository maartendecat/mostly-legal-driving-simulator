import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FragMatch,
  NO_INPUT,
  PED_MAX_HEALTH,
  createWorld,
  generateCity,
  isDead,
  spawnCar,
  spawnPed,
  stepWorld,
  type DamageCause,
  type MatchSettings,
  type Ped,
  type World,
} from '../src/index';

const SETTINGS: MatchSettings = { fragLimit: 3, timeLimitTicks: 600, intermissionTicks: 60 };

function setup(players = 3, settings = SETTINGS): { world: World; match: FragMatch; peds: Ped[] } {
  const world = createWorld(generateCity(1), 1);
  const match = new FragMatch(settings, world.tick);
  const peds = Array.from({ length: players }, () => spawnPed(world));
  peds.forEach((p) => match.addPlayer(p.id));
  return { world, match, peds };
}

/** Feeds one death to the match as if it had just happened in the world. */
function death(world: World, match: FragMatch, victim: Ped, killer: Ped | null, cause: DamageCause = 'pistol'): void {
  world.events = [{ type: 'death', tick: world.tick, ownerId: killer?.id ?? victim.id, pedId: victim.id, killerId: killer?.id ?? null, cause, x: 0, y: 0 }];
  match.update(world);
  world.events = [];
}

/** Advances the world clock and the match by `ticks` without anything happening. */
function wait(world: World, match: FragMatch, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    match.update(world);
  }
}

test('a kill is +1 for the killer and a death for the victim', () => {
  const { world, match, peds: [alice, bob] } = setup();
  death(world, match, bob!, alice!);
  assert.deepEqual(match.scores.get(alice!.id), { frags: 1, deaths: 0 });
  assert.deepEqual(match.scores.get(bob!.id), { frags: 0, deaths: 1 });
});

test('killing yourself costs a frag; accidents only count as a death', () => {
  const { world, match, peds: [alice, bob] } = setup();
  death(world, match, alice!, alice!, 'rocketLauncher');
  death(world, match, bob!, null, 'runOver');
  assert.deepEqual(match.scores.get(alice!.id), { frags: -1, deaths: 1 });
  assert.deepEqual(match.scores.get(bob!.id), { frags: 0, deaths: 1 });
});

test('the first to the frag limit wins, and the match pauses for the intermission', () => {
  const { world, match, peds: [alice, bob, carol] } = setup();
  death(world, match, bob!, alice!);
  death(world, match, carol!, alice!);
  assert.equal(match.state.phase, 'playing');
  death(world, match, bob!, alice!);
  assert.equal(match.state.phase, 'intermission');
  assert.deepEqual(match.state.winnerIds, [alice!.id]);
  assert.equal(match.state.restartAt, world.tick + SETTINGS.intermissionTicks);

  death(world, match, alice!, bob!); // e.g. a car that was already burning: doesn't count any more
  assert.deepEqual(match.scores.get(bob!.id), { frags: 0, deaths: 2 });
});

test('when time runs out, the leaders win; a tie has several winners', () => {
  const { world, match, peds: [alice, bob, carol] } = setup();
  death(world, match, carol!, alice!);
  death(world, match, carol!, bob!);
  wait(world, match, SETTINGS.timeLimitTicks);
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

  wait(world, match, SETTINGS.intermissionTicks);
  assert.equal(match.state.phase, 'playing');
  assert.deepEqual(match.state.winnerIds, []);
  assert.deepEqual(match.scores.get(alice!.id), { frags: 0, deaths: 0 });
  assert.equal(alice!.health, PED_MAX_HEALTH);
  assert.equal(alice!.weapon, null);
  assert.deepEqual(alice!.ammo, {});
  assert.equal(alice!.carId, null);
  assert.equal(car.driverId, null);
  assert.ok(!isDead(bob!));
  assert.equal(match.state.endsAt, world.tick + SETTINGS.timeLimitTicks);
});

test('real kills in the simulation are scored', () => {
  const { world, match, peds: [alice, bob] } = setup(2);
  world.cars.clear();
  Object.assign(alice!, { x: 2.5, y: 30.5, heading: Math.PI / 2, weapon: 'pistol', ammo: { pistol: 10 } });
  Object.assign(bob!, { x: 2.5, y: 33.5 });
  for (let i = 0; i < 90; i++) {
    stepWorld(world, new Map([[alice!.id, { ...NO_INPUT, fire: true }]]));
    match.update(world);
  }
  assert.deepEqual(match.scores.get(alice!.id), { frags: 1, deaths: 0 });
  assert.deepEqual(match.scores.get(bob!.id), { frags: 0, deaths: 1 });
});

test('without a frag or time limit the match never ends', () => {
  const { world, match, peds: [alice, bob] } = setup(2, { fragLimit: 0, timeLimitTicks: 0, intermissionTicks: 60 });
  for (let i = 0; i < 50; i++) death(world, match, bob!, alice!);
  wait(world, match, 100);
  assert.equal(match.state.phase, 'playing');
  assert.equal(match.state.endsAt, null);
});

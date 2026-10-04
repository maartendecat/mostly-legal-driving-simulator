import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COOP_LIVES,
  DEFAULT_MATCH_SETTINGS,
  Match,
  NO_INPUT,
  PED_MAX_HEALTH,
  WANTED_LEVEL_HEAT,
  createWorld,
  damagePed,
  generateCity,
  isLaw,
  secondsToTicks,
  spawnBribe,
  spawnPed,
  spawnProjectile,
  stepWorld,
  type MatchMode,
  type Ped,
  type World,
} from '../src/index';

/** A quiet city (no police units or traffic, so nothing interferes) with two players, in `mode`. */
function game(mode: MatchMode = 'coop'): { world: World; match: Match; alice: Ped; bob: Ped } {
  const world = createWorld(generateCity(1, 6), 1);
  world.cars.clear();
  world.pickups.clear();
  const alice = spawnPed(world, 12.5, 4.5);
  const bob = spawnPed(world, 16.5, 4.5);
  const match = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: [mode], timeLimitTicks: 0, intermissionTicks: 60 }, world);
  match.addPlayer(world, alice.id);
  match.addPlayer(world, bob.id);
  return { world, match, alice, bob };
}

function run(world: World, match: Match, ticks: number, each?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    match.update(world);
    each?.();
  }
}

/** Kills a player (as if by the police), and lets the match count it. */
function kill(world: World, match: Match, ped: Ped): void {
  world.events = [];
  damagePed(world, ped, 1000, null, 'runOver');
  match.update(world);
}

test('co-op: everyone is wanted from the start, and the pressure keeps rising, up to the army after four minutes', () => {
  const { world, match, alice, bob } = game();
  // (Keeping the police who come after them away: this is about the stars.)
  const noPolice = () => {
    for (const car of world.cars.values()) if (car.police) world.cars.delete(car.id);
    for (const ped of world.peds.values()) if (isLaw(ped)) world.peds.delete(ped.id);
    world.helicopters.clear();
  };
  const levels = { start: 0, twoMinutes: 0, fourMinutes: 0 };
  run(world, match, 2, noPolice);
  levels.start = alice.wanted;
  run(world, match, secondsToTicks(120), noPolice);
  levels.twoMinutes = alice.wanted;
  run(world, match, secondsToTicks(121), noPolice);
  levels.fourMinutes = alice.wanted;
  // (2 stars after 23 s, 3 after 57 s, 4 after 1:43, 5 after 2:40, the army at 4:00.)
  assert.deepEqual(levels, { start: 1, twoMinutes: 4, fourMinutes: 6 });
  assert.equal(bob.wanted, 6, 'everyone');
});

test('co-op: players cannot hurt each other (their own rockets still hurt themselves)', () => {
  const { world, match, alice, bob } = game();
  damagePed(world, bob, 50, alice.id, 'pistol');
  assert.equal(bob.health, PED_MAX_HEALTH);
  spawnProjectile(world, 'pistol', alice.id, bob.x - 1, bob.y, 0);
  run(world, match, 10);
  assert.equal(bob.health, PED_MAX_HEALTH, 'shot: nothing');
  damagePed(world, alice, 30, alice.id, 'rocketLauncher');
  assert.equal(alice.health, PED_MAX_HEALTH - 30);

  const versus = game('frag');
  damagePed(versus.world, versus.bob, 50, versus.alice.id, 'pistol');
  assert.equal(versus.bob.health, PED_MAX_HEALTH - 50, 'in the other modes they can');
});

test('co-op: three lives each; out of lives you watch; when everyone is out, the time held out is the score', () => {
  const { world, match, alice, bob } = game();
  run(world, match, 120);
  for (let i = 0; i < COOP_LIVES; i++) {
    kill(world, match, alice);
    run(world, match, secondsToTicks(4)); // back after each death...
  }
  assert.equal(match.scores.get(alice.id)!.lives, 0);
  assert.notEqual(alice.respawnAt, null, '...but not after the last');
  assert.equal(match.state.phase, 'playing', 'Bob is still in');

  for (let i = 0; i < COOP_LIVES; i++) {
    run(world, match, secondsToTicks(4));
    kill(world, match, bob);
  }
  assert.equal(match.state.phase, 'intermission');
  const heldOut = match.state.heldOut!;
  assert.ok(heldOut > secondsToTicks(20), `held out ${heldOut} ticks`);
  assert.equal(match.state.bestHeldOut, heldOut);
  assert.equal(alice.wanted, 0, 'the police call it off');

  // Next match: everyone back, three lives, from one star again; the best time is remembered.
  run(world, match, 61);
  assert.equal(match.state.phase, 'playing');
  assert.deepEqual([match.scores.get(alice.id)!.lives, alice.respawnAt, bob.respawnAt], [COOP_LIVES, null, null]);
  run(world, match, 2);
  assert.equal(alice.wanted, 1);
  assert.equal(match.state.bestHeldOut, heldOut);
});

test('co-op: getting busted costs a life too', () => {
  const { world, match, alice } = game();
  world.events = [{ type: 'busted', tick: world.tick, ownerId: 1, pedId: alice.id, copId: 1, x: 0, y: 0 }];
  match.update(world);
  assert.equal(match.scores.get(alice.id)!.lives, COOP_LIVES - 1);
});

test('co-op: bribes and spray shops cannot take you below the pressure', () => {
  const { world, match, alice } = game();
  run(world, match, 2);
  world.heatFloor = WANTED_LEVEL_HEAT[2];
  run(world, match, 1);
  world.heatFloor = WANTED_LEVEL_HEAT[2]; // (held there for the test)
  world.wanted.find((w) => w.pedId === alice.id)!.heat = WANTED_LEVEL_HEAT[4];
  spawnBribe(world, alice.x, alice.y);
  stepWorld(world, new Map([[alice.id, NO_INPUT]]));
  assert.equal(alice.wanted, 3, 'one star off');
  for (let i = 0; i < 3; i++) {
    spawnBribe(world, alice.x, alice.y);
    stepWorld(world, new Map());
  }
  assert.equal(alice.wanted, 2, 'but not below the pressure');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Block,
  ARREST_DELAY_TICKS,
  COOL_OFF_TICKS,
  CUFF_TICKS,
  DEFAULT_MATCH_SETTINGS,
  LEVEL_DROP_TICKS,
  Match,
  NO_INPUT,
  POINTS,
  createWorld,
  damagePed,
  generateCity,
  isBusted,
  lineOfSight,
  reportCrime,
  secondsToTicks,
  spawnBribe,
  spawnCar,
  spawnPed,
  spawnPedestrian,
  startTraffic,
  stepWorld,
  wantedLevel,
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
const heat = (world: World, ped: Ped) => world.wanted.find((w) => w.pedId === ped.id)?.heat ?? 0;
/** Shots fired by `ped` from now on. */
const countShots = (world: World, ped: Ped) => {
  const seen = new Set<number>();
  return () => {
    for (const p of world.projectiles.values()) if (p.ownerId === ped.id) seen.add(p.id);
    return seen.size;
  };
};

/** A quiet city (no cars, no pickups) with a player on the pavement row at y = 4.5. */
function street(options: { police?: 'on' | 'noarmy' | 'off' } = {}): { world: World; player: Ped } {
  const world = createWorld(generateCity(1, 6), 1, options);
  world.cars.clear();
  world.pickups.clear();
  for (let x = 4; x <= 12; x++) assert.equal(world.map.kinds[4 * world.map.width + x], Block.Pavement);
  const player = spawnPed(world, 12.5, 4.5);
  return { world, player };
}

/** A cop standing still on the same pavement, `distance` blocks west of the player (in plain sight). */
function copNearby(world: World, player: Ped, distance: number): Ped {
  const cop = spawnPedestrian(world, Math.floor(player.x - distance), 4, 'cop');
  cop.ai!.waitTicks = 10_000; // standing there, until they've got a reason to move
  return cop;
}

const armed = (player: Ped) => Object.assign(player, { weapon: 'pistol', ammo: { pistol: 99 }, heading: Math.PI / 2 });
const fire = (player: Ped) => new Map([[player.id, { ...NO_INPUT, fire: true }]]);

test('wanted levels follow the heat: 10, 30, 60, 100, 150, then the army at 220', () => {
  assert.deepEqual([0, 9, 10, 29, 30, 60, 100, 150, 219, 220, 300].map(wantedLevel), [0, 0, 1, 1, 2, 3, 4, 5, 5, 6, 6]);
});

test('minor crimes only count when the police see them', () => {
  const { world, player } = street();
  armed(player);
  run(world, secondsToTicks(2), fire(player));
  assert.equal(heat(world, player), 0, 'nobody saw it');

  copNearby(world, player, 6);
  run(world, secondsToTicks(5), fire(player));
  assert.ok(heat(world, player) > 8 && heat(world, player) < 12, `about 2 heat per second of shooting: ${heat(world, player)}`);
  assert.equal(player.wanted, 1);
});

test('a cop who cannot see it (around a corner) does not count', () => {
  const { world, player } = street();
  armed(player);
  // A pavement cell within sight range but behind a building.
  let spot: { x: number; y: number } | undefined;
  for (let y = 0; y < world.map.height && !spot; y++) {
    for (let x = 0; x < world.map.width && !spot; x++) {
      const near = Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y) < 10;
      if (near && world.map.kinds[y * world.map.width + x] === Block.Pavement && !lineOfSight(world.map, x + 0.5, y + 0.5, player.x, player.y)) spot = { x, y };
    }
  }
  assert.ok(spot, 'a corner to hide behind');
  spawnPedestrian(world, spot.x, spot.y, 'cop').ai!.waitTicks = 10_000;
  run(world, secondsToTicks(2), fire(player));
  assert.equal(heat(world, player), 0);
});

test('killing another player is no crime, even in front of a cop; killing a cop is a big one', () => {
  const { world, player } = street();
  copNearby(world, player, 5);
  const other = spawnPed(world, 13.5, 4.5);
  damagePed(world, other, 1000, player.id, 'pistol');
  assert.equal(heat(world, player), 0);
  const cop = copNearby(world, player, 3);
  damagePed(world, cop, 1000, player.id, 'pistol');
  assert.equal(player.wanted, 2, 'killing a cop: two stars at once');
});

test('the crimes add up: running people over, killing them, stealing cars, wrecking them', () => {
  const { world, player } = street();
  copNearby(world, player, 6);
  const civilian = spawnPedestrian(world, 13, 4);
  damagePed(world, civilian, 10, player.id, 'runOver');
  assert.equal(heat(world, player), 5);
  damagePed(world, civilian, 1000, player.id, 'pistol');
  assert.equal(heat(world, player), 20);
  const car = spawnCar(world, 'sedan', 12.5, 3.4, Math.PI); // on the westbound lane
  assert.ok(startTraffic(world, car), 'a traffic car, with a driver');
  car.vx = 0;
  stepWorld(world, new Map([[player.id, { ...NO_INPUT, enter: true }]]));
  assert.equal(player.carId, car.id);
  assert.equal(heat(world, player), 30, 'stealing a car with its driver in it');
  assert.equal(player.wanted, 2);
});

test('out of sight, the stars go one by one: the first after 25 s, then every 15 s', () => {
  const { world, player } = street();
  reportCrime(world, player.id, 'killCop');
  reportCrime(world, player.id, 'killCop');
  assert.equal(player.wanted, 3);
  const levels: number[] = [];
  run(world, COOL_OFF_TICKS + 3 * LEVEL_DROP_TICKS + 1, new Map(), () => {
    // (Keeping the police cars that come after them away: this is about the stars.)
    for (const car of world.cars.values()) if (car.police) world.cars.delete(car.id);
    if (levels.at(-1) !== player.wanted) levels.push(player.wanted);
  });
  assert.deepEqual(levels, [3, 2, 1, 0]);
});

test('without the army the stars stop at five; with it, they go to six; police off: no crimes at all', () => {
  for (const [police, max] of [['on', 6], ['noarmy', 5], ['off', 0]] as const) {
    const { world, player } = street({ police });
    for (let i = 0; i < 10; i++) reportCrime(world, player.id, 'killCop');
    assert.equal(player.wanted, max, police);
  }
});

test('police off: no cops, no police cars, no bribes', () => {
  const world = createWorld(generateCity(2, 6), 2, { traffic: 6, cops: 4, policeCars: 2, police: 'off' });
  run(world, 300);
  assert.equal([...world.peds.values()].filter((p) => p.kind === 'cop').length, 0);
  assert.equal([...world.cars.values()].filter((c) => c.police).length, 0);
  assert.equal([...world.pickups.values()].filter((p) => p.kind === 'bribe').length, 0);
  assert.ok(createWorld(generateCity(2, 6), 2).map.bribeSpawns.length > 0, 'with police, there are bribes');
});

test('one star: cops only try to arrest; two: they shoot back at a shooter; three: on sight', () => {
  const shotsAt = (level: number, hostile: boolean) => {
    const { world, player } = street();
    const cop = copNearby(world, player, 8);
    cop.ai!.waitTicks = 0;
    const record = { pedId: player.id, heat: [0, 10, 30, 60][level]!, unseenTicks: 0, hostileUntil: hostile ? 10_000 : 0, lastCrimeTick: {}, highTicks: 0 };
    world.wanted.push(record);
    player.wanted = level;
    const shots = countShots(world, cop);
    run(world, secondsToTicks(1.5));
    return shots();
  };
  assert.equal(shotsAt(1, true), 0);
  assert.equal(shotsAt(2, false), 0);
  assert.ok(shotsAt(2, true) > 0);
  assert.ok(shotsAt(3, false) > 0);
});

test('an arrest takes a moment to get hold, then a second of cuffing; walking away in time breaks free', () => {
  const { world, player } = street();
  copNearby(world, player, 3).ai!.waitTicks = 0;
  reportCrime(world, player.id, 'assaultPolice');
  let most = 0;
  let bustedAt = -1;
  run(world, secondsToTicks(5), new Map(), () => {
    most = Math.max(most, player.beingArrested);
    if (bustedAt < 0 && isBusted(player)) bustedAt = world.tick;
  });
  assert.ok(bustedAt > 0, 'standing still: busted');
  assert.ok(bustedAt >= ARREST_DELAY_TICKS + CUFF_TICKS, `not before two seconds of contact (${bustedAt} ticks)`);
  assert.ok(most > 0.9, 'after being held for (nearly) the whole second');

  const second = street();
  const cop = copNearby(second.world, second.player, 3);
  cop.ai!.waitTicks = 0;
  reportCrime(second.world, second.player.id, 'assaultPolice');
  // Wait until the cop has hold, half-way through cuffing...
  for (let i = 0; i < secondsToTicks(5) && second.player.beingArrested < 0.5; i++) stepWorld(second.world, new Map());
  assert.ok(second.player.beingArrested >= 0.5);
  // ...then walk off (east, away from the cop).
  second.player.heading = 0;
  run(second.world, CUFF_TICKS, new Map([[second.player.id, { ...NO_INPUT, up: true }]]));
  assert.equal(second.player.respawnAt, null, 'broke free');
  assert.ok(Math.hypot(cop.x - second.player.x, cop.y - second.player.y) > 1.5, 'and got a head start');
});

test('above three stars there are no more arrests', () => {
  const { world, player } = street();
  copNearby(world, player, 1).ai!.waitTicks = 0;
  world.wanted.push({ pedId: player.id, heat: 100, unseenTicks: 0, hostileUntil: 0, lastCrimeTick: {}, highTicks: 0 });
  player.wanted = 4;
  run(world, secondsToTicks(3));
  assert.equal(player.respawnAt === null || player.health <= 0, true, 'shot, maybe, but not busted');
  assert.ok(!isBusted(player));
});

test('from two stars police cars from all over the city give chase, and reinforcements come', () => {
  const world = createWorld(generateCity(3, 6), 3, { traffic: 4, policeCars: 2 });
  run(world, 300);
  const player = spawnPed(world, 40.5, 40.5);
  const far = [...world.cars.values()].filter((c) => c.police && c.traffic && Math.hypot(c.x - player.x, c.y - player.y) > 20);
  reportCrime(world, player.id, 'killCop');
  assert.equal(player.wanted, 2);
  const seen = new Set<number>();
  run(world, secondsToTicks(3), new Map(), () => {
    for (const c of world.cars.values()) if (c.police) seen.add(c.id);
  });
  assert.ok(far.every((c) => c.traffic === null || (c.traffic.pursuing === player.id && c.siren)), 'every police car is after them');
  const crewed = () => [...world.cars.values()].filter((c) => c.police && c.traffic);
  assert.equal(seen.size, 2 + 2, 'two more police cars');

  // Once nobody's wanted, the reinforcements disappear (out of sight).
  world.wanted = [];
  player.wanted = 0;
  player.x = 2.5;
  player.y = 2.5;
  run(world, secondsToTicks(30));
  assert.equal(crewed().length, 2);
});

test('a cop bribe takes a star off, for a wanted player; others leave it lying there', () => {
  const { world, player } = street();
  const bribe = spawnBribe(world, player.x, player.y);
  stepWorld(world, new Map());
  assert.equal(bribe.availableAt, 0, 'not wanted: not taken');
  reportCrime(world, player.id, 'killCop');
  assert.equal(player.wanted, 2);
  stepWorld(world, new Map());
  assert.equal(player.wanted, 1);
  assert.ok(bribe.availableAt > world.tick + secondsToTicks(50), 'back in a minute');
});

test('busted in Points mode costs 250 points (and counts as a death)', () => {
  const { world, player } = street();
  const match = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: ['points'] }, world);
  match.addPlayer(world, player.id);
  world.events = [{ type: 'busted', tick: 0, ownerId: 1, pedId: player.id, copId: 1, x: 0, y: 0 }];
  match.update(world);
  assert.equal(match.scores.get(player.id)!.points, POINTS.busted);
  assert.equal(POINTS.busted, -250);
  assert.equal(match.scores.get(player.id)!.deaths, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Block,
  DEFAULT_MATCH_SETTINGS,
  GANGS,
  GRUDGE_TICKS,
  Match,
  NO_INPUT,
  POINTS,
  cloneWorld,
  createWorld,
  damagePed,
  generateCity,
  secondsToTicks,
  spawnPed,
  spawnPedestrian,
  stepWorld,
  turfAt,
  type BlockMap,
  type Ped,
  type World,
} from '../src/index';

const run = (world: World, ticks: number, each?: () => void) => {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    each?.();
  }
};
const living = (world: World, kind: Ped['kind']) => [...world.peds.values()].filter((p) => p.kind === kind && p.respawnAt === null);
const kindAtCell = (map: BlockMap, x: number, y: number) => map.kinds[y * map.width + x];

/** A pavement cell on `gang`'s turf with more of its pavement 4 cells east, in plain sight. */
function turfStretch(map: BlockMap, gang: number): { x: number; y: number } {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width - 4; x++) {
      const pavement = [0, 1, 2, 3, 4].every((dx) => kindAtCell(map, x + dx, y) === Block.Pavement && turfAt(map, x + dx + 0.5, y + 0.5) === gang);
      if (pavement) return { x, y };
    }
  }
  throw new Error('no turf');
}

/** A quiet city (no cars or pickups) with one gang member, and a player 4 blocks east of them. */
function standoff(): { world: World; member: Ped; player: Ped } {
  const world = createWorld(generateCity(1, 6), 1);
  world.cars.clear();
  world.pickups.clear();
  const at = turfStretch(world.map, 1);
  const member = spawnPedestrian(world, at.x, at.y, 'gangster', 1);
  const player = spawnPed(world, at.x + 4.5, at.y + 0.5);
  return { world, member, player };
}

test('each gang has its own turf: a corner of the city, with neutral ground and roads in between', () => {
  const map = generateCity(1, 6);
  const cells = new Map<number, number>();
  for (let i = 0; i < map.territory.length; i++) {
    const gang = map.territory[i]!;
    cells.set(gang, (cells.get(gang) ?? 0) + 1);
    if (gang !== 0) assert.notEqual(map.kinds[i], Block.Road, 'roads are nobody’s');
  }
  for (let gang = 1; gang <= GANGS.length; gang++) assert.ok((cells.get(gang) ?? 0) > 200, `gang ${gang} has turf`);
  assert.ok(cells.get(0)! > map.territory.length / 2, 'most of the city is neutral');
  assert.deepEqual(generateCity(1, 6).territory, map.territory);
});

test('the city keeps its gang members on their turf, armed, and its cops and civilians around', () => {
  const world = createWorld(generateCity(3, 6), 3, { traffic: 8, pedestrians: 20, gangMembers: 5, cops: 4 });
  let samples = 0;
  let onTurf = 0;
  run(world, secondsToTicks(180), () => {
    if (world.tick % 30) return;
    for (const p of living(world, 'gangster')) {
      samples++;
      if (turfAt(world.map, p.x, p.y) === p.gang) onTurf++;
    }
  });
  for (let gang = 1; gang <= GANGS.length; gang++) assert.equal(living(world, 'gangster').filter((p) => p.gang === gang).length, 5);
  assert.equal(living(world, 'cop').length, 4);
  assert.equal(living(world, 'civilian').length, 20);
  assert.ok(living(world, 'gangster').every((p) => p.weapon === 'pistol'));
  // Off their turf only briefly: crossing the road between their blocks, or dodging a car.
  assert.ok(onTurf / samples > 0.85, `on their turf ${((100 * onTurf) / samples).toFixed(0)}% of the time`);
  const looks = new Set(living(world, 'civilian').map((p) => p.look));
  assert.ok(looks.size >= 3, `civilians look different: ${[...looks]}`);
});

test('gang members and cops do not panic at gunfire; civilians do', () => {
  const { world, member } = standoff();
  const cop = spawnPedestrian(world, member.x - 0.5 + 1, member.y - 0.5, 'cop');
  const civilian = spawnPedestrian(world, member.x - 0.5 + 2, member.y - 0.5);
  const shooter = spawnPed(world, member.x + 1, member.y + 3);
  Object.assign(shooter, { heading: Math.PI / 2, weapon: 'pistol', ammo: { pistol: 5 } });
  stepWorld(world, new Map([[shooter.id, { ...NO_INPUT, fire: true }]]));
  run(world, 10);
  assert.ok(civilian.ai!.panicTicks > 0, 'the civilian runs');
  assert.equal(member.ai!.panicTicks, 0);
  assert.equal(cop.ai!.panicTicks, 0);
});

test('hurt a gang member and the gang is after you: they shoot back', () => {
  const { world, member, player } = standoff();
  damagePed(world, member, 10, player.id, 'pistol');
  assert.deepEqual(world.grudges, [{ gang: 1, pedId: player.id, until: world.tick + GRUDGE_TICKS }]);
  assert.ok(world.events.some((e) => e.type === 'gangAngry' && e.pedId === player.id && e.gang === 1));
  let shots = 0;
  const seen = new Set<number>();
  run(world, secondsToTicks(10), () => {
    for (const p of world.projectiles.values()) if (p.ownerId === member.id && !seen.has(p.id)) seen.add(p.id) && shots++;
  });
  // About one shot a second after taking aim; not every one hits.
  assert.ok(shots >= 6 && shots <= 9, `${shots} shots in 10 s`);
  // Not every shot hits (at 4 blocks, about one in four), but they do hit.
  run(world, secondsToTicks(20));
  assert.ok(player.health < 100, 'they hit, sometimes');
});

test('a grudge is announced once, refreshed by more trouble, and forgotten after a while', () => {
  const { world, member, player } = standoff();
  player.x = member.x + 14; // out of reach, so nobody shoots
  damagePed(world, member, 10, player.id, 'pistol');
  run(world, secondsToTicks(10));
  damagePed(world, member, 10, player.id, 'pistol');
  assert.equal(world.events.filter((e) => e.type === 'gangAngry').length, 0, 'no second announcement');
  assert.equal(world.grudges.length, 1);
  run(world, GRUDGE_TICKS - 1);
  assert.equal(world.grudges.length, 1, 'refreshed');
  run(world, 2);
  assert.equal(world.grudges.length, 0, 'forgotten');
});

test('only players make gangs angry; and a gang leaves alone those it holds no grudge against', () => {
  const { world, member, player } = standoff();
  damagePed(world, member, 10, null, 'runOver');
  const other = spawnPedestrian(world, member.x - 0.5, member.y - 0.5 + 0, 'gangster', 2);
  damagePed(world, member, 10, other.id, 'pistol');
  assert.equal(world.grudges.length, 0);
  run(world, secondsToTicks(3));
  assert.equal(player.health, 100);
});

test('gang members chase someone they are after who is out of range', () => {
  const { world, member, player } = standoff();
  damagePed(world, member, 10, player.id, 'pistol');
  player.x = member.x + 13; // further than they shoot, close enough to notice
  const before = Math.hypot(player.x - member.x, player.y - member.y);
  run(world, secondsToTicks(1));
  assert.ok(Math.hypot(player.x - member.x, player.y - member.y) < before - 2, 'they come closer');
});

test('gang members and cops are worth more points than ordinary pedestrians', () => {
  const { world, member } = standoff();
  const cop = spawnPedestrian(world, member.x - 0.5, member.y - 0.5, 'cop');
  const match = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: ['points'] }, world);
  const killer = spawnPed(world, 30.5, 4.5);
  match.addPlayer(world, killer.id);
  world.events = [member, cop].map((victim) => ({ type: 'death', tick: 0, ownerId: killer.id, pedId: victim.id, killerId: killer.id, cause: 'pistol', x: 0, y: 0 }) as const);
  match.update(world);
  assert.equal(match.scores.get(killer.id)!.points, POINTS.gangster + POINTS.cop);
});

test('gangs replay identically, fights included', () => {
  const world = createWorld(generateCity(5, 6), 5, { traffic: 8, pedestrians: 10, gangMembers: 4, cops: 2 });
  run(world, 400);
  const player = spawnPed(world, ...(() => {
    const member = living(world, 'gangster')[0]!;
    return [member.x + 3, member.y] as const;
  })());
  damagePed(world, living(world, 'gangster')[0]!, 10, player.id, 'pistol');
  const copy = cloneWorld(world);
  run(world, 300);
  run(copy, 300);
  assert.deepEqual([...copy.peds.values()], [...world.peds.values()]);
  assert.deepEqual(copy.grudges, world.grudges);
  assert.equal(copy.rngState, world.rngState);
});

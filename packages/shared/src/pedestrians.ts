import { fireWeapon } from './combat';
import { isDead } from './damage';
import { GANGS, GANG_NOTICE_RANGE, GANG_SHOOT_RANGE, expireGrudges, turfAt } from './gangs';
import { Block, DIRECTIONS, Lane, isSolidAt, kindAt, laneAt, type BlockMap } from './map';
import { nextRandom, randomInt, randomPick, wrapAngle } from './math';
import { secondsToTicks } from './time';
import { WEAPONS } from './weapons';
import { carSpeed, pedCollides, spawnPed, type Ped, type PedKind, type PedLook, type World } from './world';

/**
 * Pedestrians: the people walking around the city. They stroll along the pavements cell by cell,
 * turn at corners, stop now and then, and sometimes cross the road (after checking for traffic).
 * Gunfire, explosions, bodies or a car speeding at them make them run away for a while. They can
 * be shot and run over; bodies are cleared after a while and new pedestrians appear out of sight.
 *
 * Besides ordinary civilians there are gang members and cops. Neither panics (though they do jump
 * out of the way of cars). Gang members stay on their gang's turf, armed; when their gang holds a
 * grudge against a player (see gangs.ts) those nearby come after them and shoot. Cops walk the
 * whole city on patrol (what they do about crime comes with the police, later).
 */

export interface PedestrianState {
  /** Walking direction (index into DIRECTIONS). */
  dir: number;
  /** The point (a cell centre) they're walking to. */
  target: { x: number; y: number };
  /** Standing still for this many ticks. */
  waitTicks: number;
  /** Running away for this many ticks, from `panicFrom`. */
  panicTicks: number;
  panicFrom: { x: number; y: number } | null;
  /** When running from a car: its direction, so they get out of its path (sideways). */
  panicPath: { x: number; y: number } | null;
  /** Walking straight across a road to the pavement on the other side. */
  crossing: boolean;
  /** Ticks without getting closer to the target... */
  stuckTicks: number;
  /** ...measured from tick to tick (a parked car pushing them back undoes each step after it's made). */
  lastDistance: number;
  /** A gang member with someone in their sights: ticks spent aiming so far. */
  aimTicks: number;
}

const WALK_SPEED = 1.4;
/** Crossing the road: a brisk walk, to spend less time in front of traffic. */
const CROSSING_SPEED = 2.2;
const RUN_SPEED = 3.2;
/** How quickly they turn to face where they're going, in radians per second. */
const TURN_RATE = 7;
const PANIC_TICKS = secondsToTicks(4);
/** Gang members and cops only jump out of a car's way, briefly. */
const DODGE_TICKS = secondsToTicks(1);
/** Gunfire, explosions and deaths this close (in blocks) make pedestrians panic. */
const PANIC_RADIUS = 7;
/** A car coming at them this fast (blocks/s), from this close, makes them run. */
const DANGER_CAR_SPEED = 4;
const DANGER_CAR_DISTANCE = 4.5;
/** Chances per cell walked: stopping for a moment, and crossing the road where they can. */
const PAUSE_CHANCE = 0.03;
const CROSS_CHANCE = 0.2;
/** Bodies stay this long before they're cleared away. */
export const CORPSE_TICKS = secondsToTicks(20);
/** New pedestrians only appear this far from every player, so nobody sees them pop in. */
const SPAWN_DISTANCE_FROM_PLAYERS = 14;
/** Civilians' looks, weighted by how common they are, and how fast each walks (relative). */
const CIVILIAN_LOOKS: PedLook[] = ['man', 'man', 'man', 'woman', 'woman', 'woman', 'youth', 'youth', 'worker', 'worker', 'elder'];
const PACE: Record<PedLook, number> = { man: 1, woman: 1, youth: 1.15, worker: 1, elder: 0.6 };
/** A gang member takes this long to aim before the first shot... */
const GANG_AIM_TICKS = secondsToTicks(0.5);
/** ...then fires a little more than once a second (slower than a player can)... */
const GANG_SHOT_TICKS = secondsToTicks(1.25);
/** ...and not very accurately: up to this far off (radians). */
const GANG_AIM_ERROR = 0.16;
/** Police blue, for asset packs that colour people. */
export const COP_COLOR = 0x1e40af;
/** A distance further than any target, for "no progress measured yet". */
const FAR = 1e6;

export function isPedestrian(ped: Ped): boolean {
  return ped.kind !== 'player';
}

/**
 * Adds one of the city's people standing at the centre of a pavement cell: a civilian, a member of
 * `gang`, or a cop. Gang members and cops carry a pistol.
 */
export function spawnPedestrian(world: World, cx: number, cy: number, kind: Exclude<PedKind, 'player'> = 'civilian', gang = 0): Ped {
  const ped = spawnPed(world, cx + 0.5, cy + 0.5);
  ped.kind = kind;
  ped.gang = kind === 'gangster' ? gang : 0;
  if (kind === 'gangster') ped.color = GANGS[gang - 1]?.color ?? ped.color;
  if (kind === 'cop') ped.color = COP_COLOR;
  if (kind === 'civilian') ped.look = randomPick(world, CIVILIAN_LOOKS);
  else {
    ped.look = 'man';
    ped.weapon = 'pistol';
    ped.ammo = { pistol: WEAPONS.pistol.maxAmmo };
  }
  const dir = randomInt(world, 4);
  ped.heading = DIRECTIONS[dir]!.heading;
  ped.ai = { dir, target: { x: cx + 0.5, y: cy + 0.5 }, waitTicks: 0, panicTicks: 0, panicFrom: null, panicPath: null, crossing: false, stuckTicks: 0, lastDistance: FAR, aimTicks: 0 };
  return ped;
}

/** Moves every pedestrian for one tick. Runs after projectiles, so it sees this tick's events. */
export function stepPedestrians(world: World, dt: number): void {
  expireGrudges(world);
  for (const ped of world.peds.values()) {
    const ai = ped.ai;
    if (!ai || ped.respawnAt !== null || ped.carId !== null) continue;
    if (ped.kind === 'gangster' && fightGrudge(world, ped, ai, dt)) continue;
    noticeDanger(world, ped, ai);
    walk(world, ped, ai, dt);
  }
}

/**
 * Keeps the number of (living) civilians, gang members (per gang, on their turf) and cops at the
 * world's targets, adding at most one of each per tick, out of every player's sight.
 */
export function maintainPedestrians(world: World): void {
  const counts = new Map<string, number>();
  for (const ped of world.peds.values()) {
    if (ped.kind === 'player' || ped.respawnAt !== null) continue;
    const key = ped.kind === 'gangster' ? `gang${ped.gang}` : ped.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ((counts.get('civilian') ?? 0) < world.pedestrianTarget) trySpawn(world, pavementCells(world.map), 'civilian');
  if ((counts.get('cop') ?? 0) < world.copTarget) trySpawn(world, pavementCells(world.map), 'cop');
  for (let gang = 1; gang <= GANGS.length && world.gangTarget > 0; gang++) {
    if ((counts.get(`gang${gang}`) ?? 0) < world.gangTarget) trySpawn(world, turfCells(world.map, gang), 'gangster', gang);
  }
}

function trySpawn(world: World, cells: { x: number; y: number }[], kind: Exclude<PedKind, 'player'>, gang = 0): void {
  if (cells.length === 0) return;
  const cell = randomPick(world, cells);
  const x = cell.x + 0.5;
  const y = cell.y + 0.5;
  for (const ped of world.peds.values()) {
    if (ped.kind === 'player' && Math.hypot(ped.x - x, ped.y - y) < SPAWN_DISTANCE_FROM_PLAYERS) return;
  }
  for (const car of world.cars.values()) if (Math.hypot(car.x - x, car.y - y) < 1) return;
  spawnPedestrian(world, cell.x, cell.y, kind, gang);
}

/**
 * A gang member and the nearest player their gang is after, if any is close: if they can see them
 * and they're in range, aim and shoot; otherwise run towards them. Returns false when there's no
 * one to fight, so they just walk around.
 */
function fightGrudge(world: World, ped: Ped, ai: PedestrianState, dt: number): boolean {
  let enemy: Ped | undefined;
  let enemyDistance = GANG_NOTICE_RANGE;
  for (const grudge of world.grudges) {
    if (grudge.gang !== ped.gang) continue;
    const target = world.peds.get(grudge.pedId);
    if (!target || isDead(target)) continue;
    const distance = Math.hypot(target.x - ped.x, target.y - ped.y);
    if (distance < enemyDistance) {
      enemy = target;
      enemyDistance = distance;
    }
  }
  if (!enemy) {
    ai.aimTicks = 0;
    return false;
  }
  // Whatever they were doing, this comes first; afterwards they pick a new way from where they are.
  Object.assign(ai, { waitTicks: 0, panicTicks: 0, panicFrom: null, panicPath: null, crossing: false, stuckTicks: 0, lastDistance: FAR });
  ai.target = { x: Math.floor(ped.x) + 0.5, y: Math.floor(ped.y) + 0.5 };

  const dx = enemy.x - ped.x;
  const dy = enemy.y - ped.y;
  const aim = Math.atan2(dy, dx);
  if (enemyDistance <= GANG_SHOOT_RANGE && lineOfSight(world.map, ped.x, ped.y, enemy.x, enemy.y)) {
    const turn = wrapAngle(aim - ped.heading);
    const maxTurn = TURN_RATE * dt;
    ped.heading = wrapAngle(ped.heading + Math.max(-maxTurn, Math.min(maxTurn, turn)));
    if (Math.abs(turn) > 0.2) return true;
    if (ai.aimTicks < GANG_AIM_TICKS) {
      ai.aimTicks++;
      return true;
    }
    if (ped.fireCooldown === 0 && ped.weapon !== null) {
      ped.heading = wrapAngle(aim + (nextRandom(world) * 2 - 1) * GANG_AIM_ERROR);
      fireWeapon(world, ped);
      ped.fireCooldown = Math.max(ped.fireCooldown, GANG_SHOT_TICKS);
      ped.heading = aim;
    }
    return true;
  }
  // Out of range or out of sight: run at them (sliding along walls).
  ai.aimTicks = 0;
  ped.heading = aim;
  const step = RUN_SPEED * dt;
  const sx = (dx / enemyDistance) * step;
  const sy = (dy / enemyDistance) * step;
  if (!pedCollides(world.map, ped.x + sx, ped.y)) ped.x += sx;
  if (!pedCollides(world.map, ped.x, ped.y + sy)) ped.y += sy;
  return true;
}

/** Nothing solid on the straight line between two points. */
function lineOfSight(map: BlockMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25);
  for (let i = 1; i < steps; i++) {
    if (isSolidAt(map, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)) return false;
  }
  return true;
}

function noticeDanger(world: World, ped: Ped, ai: PedestrianState): void {
  let source: { x: number; y: number } | null = null;
  let path: { x: number; y: number } | null = null;
  const near = (x: number, y: number) => Math.hypot(x - ped.x, y - ped.y) < PANIC_RADIUS;
  // Impacts, explosions, deaths, and bullets or rockets flying past. Gang members and cops are
  // used to that; only a car coming at them makes them move.
  const fearless = ped.kind !== 'civilian';
  for (const event of world.events) {
    if (fearless) break;
    if (event.type !== 'carDestroyed' && event.type !== 'gangAngry' && near(event.x, event.y)) source = { x: event.x, y: event.y };
  }
  for (const projectile of world.projectiles.values()) {
    if (fearless) break;
    if (near(projectile.x, projectile.y)) source = { x: projectile.x, y: projectile.y };
  }
  for (const car of world.cars.values()) {
    const speed = carSpeed(car);
    if (speed < DANGER_CAR_SPEED) continue;
    // Only a car actually heading at them: ahead of it, close, and within about a car's width of
    // its path (not traffic simply driving past the pavement).
    const dx = ped.x - car.x;
    const dy = ped.y - car.y;
    const ahead = (dx * car.vx + dy * car.vy) / speed;
    const aside = Math.abs(dx * car.vy - dy * car.vx) / speed;
    if (ahead <= 0 || ahead > DANGER_CAR_DISTANCE || aside > 0.8) continue;
    // A car coming at them: jump out of its path (sideways), rather than running ahead of it.
    source = { x: car.x, y: car.y };
    path = { x: car.vx / speed, y: car.vy / speed };
  }
  if (!source) return;
  const startled = ai.panicTicks === 0;
  ai.panicTicks = fearless ? DODGE_TICKS : PANIC_TICKS;
  ai.panicFrom = source;
  ai.panicPath = path;
  ai.waitTicks = 0;
  ai.crossing = false;
  if (startled) chooseNext(world, ped, ai); // run at once, don't finish the step first
}

function walk(world: World, ped: Ped, ai: PedestrianState, dt: number): void {
  if (ai.panicTicks > 0 && --ai.panicTicks === 0) ai.panicFrom = ai.panicPath = null;
  if (ai.waitTicks > 0) {
    ai.waitTicks--;
    return;
  }
  let dx = ai.target.x - ped.x;
  let dy = ai.target.y - ped.y;
  if (Math.hypot(dx, dy) < 0.12) {
    chooseNext(world, ped, ai);
    if (ai.waitTicks > 0) return;
    dx = ai.target.x - ped.x;
    dy = ai.target.y - ped.y;
  }
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return;

  // Face where they're going (turning quickly but not instantly), and step that way.
  const wanted = Math.atan2(dy, dx);
  const turn = wrapAngle(wanted - ped.heading);
  const maxTurn = TURN_RATE * dt;
  ped.heading = wrapAngle(ped.heading + Math.max(-maxTurn, Math.min(maxTurn, turn)));
  const speed = ai.panicTicks > 0 ? RUN_SPEED : (ai.crossing ? CROSSING_SPEED : WALK_SPEED) * PACE[ped.look];
  const step = Math.min(speed * dt, distance);
  const sx = (dx / distance) * step;
  const sy = (dy / distance) * step;
  if (!pedCollides(world.map, ped.x + sx, ped.y)) ped.x += sx;
  if (!pedCollides(world.map, ped.x, ped.y + sy)) ped.y += sy;

  // Blocked (by a wall or a parked car, say) and not getting anywhere: pick somewhere else to go.
  ai.stuckTicks = distance < ai.lastDistance - step * 0.5 ? 0 : ai.stuckTicks + 1;
  ai.lastDistance = distance;
  if (ai.stuckTicks > 45) {
    ai.stuckTicks = 0;
    ai.crossing = false;
    ai.dir = randomInt(world, 4);
    chooseNext(world, ped, ai);
  }
}

/** Picks the next cell to walk to (and sometimes decides to stop for a moment). */
function chooseNext(world: World, ped: Ped, ai: PedestrianState): void {
  const map = world.map;
  const cx = Math.floor(ped.x);
  const cy = Math.floor(ped.y);
  const go = (dir: number) => {
    ai.dir = dir;
    ai.lastDistance = FAR;
    ai.target = { x: cx + DIRECTIONS[dir]!.dx + 0.5, y: cy + DIRECTIONS[dir]!.dy + 0.5 };
  };
  const kindAhead = (dir: number) => kindAt(map, cx + DIRECTIONS[dir]!.dx, cy + DIRECTIONS[dir]!.dy);

  if (ai.panicTicks > 0 && ai.panicFrom) {
    // Run: any open cell that takes us furthest from the danger.
    let best = -1;
    let bestDistance = -Infinity;
    for (let dir = 0; dir < 4; dir++) {
      const kind = kindAhead(dir);
      if (kind === Block.Building || kind === Block.Water) continue;
      const d = DIRECTIONS[dir]!;
      // Furthest from the danger, preferring off the road. For a car: furthest from its path,
      // wherever that is (getting out of the way matters more than staying off the road).
      const offRoad = kind === Block.Road && !ai.panicPath ? -1.5 : 0;
      const rx = cx + d.dx + 0.5 - ai.panicFrom.x;
      const ry = cy + d.dy + 0.5 - ai.panicFrom.y;
      const away = ai.panicPath ? Math.abs(rx * ai.panicPath.y - ry * ai.panicPath.x) : Math.hypot(rx, ry);
      const distance = away + offRoad + nextRandom(world) * 0.3;
      if (distance > bestDistance) {
        bestDistance = distance;
        best = dir;
      }
    }
    if (best >= 0) go(best);
    return;
  }

  if (ai.crossing) {
    // Keep going straight across; done once we're on the pavement on the other side.
    if (kindAhead(ai.dir) === Block.Road || kindAhead(ai.dir) === Block.Pavement) {
      if (kindAhead(ai.dir) === Block.Pavement) ai.crossing = false;
      go(ai.dir);
      return;
    }
    ai.crossing = false;
  }

  if (kindAt(map, cx, cy) !== Block.Pavement) {
    // Ended up off the pavement (after running away): head back to the nearest bit of pavement.
    const home = nearestPavement(map, cx, cy);
    if (home) {
      // Step towards it, avoiding the traffic lanes if another way gets us closer too.
      const closer = [0, 1, 2, 3].filter((dir) => {
        const d = DIRECTIONS[dir]!;
        const kind = kindAhead(dir);
        const nearer = Math.abs(home.x - cx - d.dx) + Math.abs(home.y - cy - d.dy) < Math.abs(home.x - cx) + Math.abs(home.y - cy);
        return nearer && kind !== Block.Building && kind !== Block.Water;
      });
      const isLane = (dir: number) => laneAt(map, cx + DIRECTIONS[dir]!.dx, cy + DIRECTIONS[dir]!.dy) !== 0;
      const dir = closer.find((d) => !isLane(d)) ?? closer[0];
      if (dir !== undefined) {
        go(dir);
        return;
      }
    }
  }

  if (nextRandom(world) < PAUSE_CHANCE) {
    ai.waitTicks = secondsToTicks(1 + nextRandom(world) * 2);
    return;
  }

  // Gang members keep to their turf, or head back to it when they've strayed.
  const turf = ped.kind === 'gangster' ? ped.gang : 0;
  const onTurf = turf !== 0 && turfAt(map, cx + 0.5, cy + 0.5) === turf;
  const home = turf !== 0 && !onTurf ? turfCentre(map, turf) : null;
  const allowed = (x: number, y: number) =>
    turf === 0 || (onTurf ? turfAt(map, x + 0.5, y + 0.5) === turf : Math.abs(home!.x - x) + Math.abs(home!.y - y) < Math.abs(home!.x - cx) + Math.abs(home!.y - cy));

  // At the kerb facing the road: sometimes cross, if no traffic is coming.
  const across = kindAhead(ai.dir) === Block.Road && nextRandom(world) < CROSS_CHANCE ? crossingEnd(map, cx, cy, ai.dir) : null;
  if (across && allowed(across.x, across.y)) {
    if (trafficNear(world, cx, cy, ai.dir)) {
      ai.waitTicks = secondsToTicks(0.8);
      return;
    }
    ai.crossing = true;
    go(ai.dir);
    return;
  }

  // Otherwise follow the pavement: mostly straight on, sometimes turning; back only at a dead end.
  const pavementAhead = (dir: number) => kindAhead(dir) === Block.Pavement;
  const allowedAhead = (dir: number) => allowed(cx + DIRECTIONS[dir]!.dx, cy + DIRECTIONS[dir]!.dy);
  let options = [
    { dir: ai.dir, weight: 6 },
    { dir: (ai.dir + 1) % 4, weight: 2 },
    { dir: (ai.dir + 3) % 4, weight: 2 },
  ].filter((o) => pavementAhead(o.dir));
  // On their turf they stay on it; off it they prefer the ways home (but don't get stuck).
  if (onTurf) options = options.filter((o) => allowedAhead(o.dir));
  else if (home) options = options.map((o) => (allowedAhead(o.dir) ? { ...o, weight: o.weight * 5 } : o));
  if (options.length === 0) {
    const back = (ai.dir + 2) % 4;
    if (pavementAhead(back) && (!onTurf || allowedAhead(back))) go(back);
    else ai.waitTicks = secondsToTicks(0.5);
    return;
  }
  let roll = nextRandom(world) * options.reduce((sum, o) => sum + o.weight, 0);
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return go(option.dir);
  }
  go(options.at(-1)!.dir);
}

/**
 * A straight crossing: a few road cells (no intersection) with pavement on the other side. Returns
 * that pavement cell, or null if there's no crossing here.
 */
function crossingEnd(map: BlockMap, cx: number, cy: number, dir: number): { x: number; y: number } | null {
  const d = DIRECTIONS[dir]!;
  for (let n = 1; n <= 5; n++) {
    const x = cx + d.dx * n;
    const y = cy + d.dy * n;
    const kind = kindAt(map, x, y);
    if (kind === Block.Pavement) return n > 1 ? { x, y } : null;
    if (kind !== Block.Road || laneAt(map, x, y) & Lane.Intersection) return null;
  }
  return null;
}

/** Any moving car near the road we're about to cross. */
function trafficNear(world: World, cx: number, cy: number, dir: number): boolean {
  const d = DIRECTIONS[dir]!;
  const midX = cx + 0.5 + d.dx * 2;
  const midY = cy + 0.5 + d.dy * 2;
  for (const car of world.cars.values()) {
    if (carSpeed(car) > 0.5 && Math.hypot(car.x - midX, car.y - midY) < 8) return true;
  }
  return false;
}

function nearestPavement(map: BlockMap, cx: number, cy: number): { x: number; y: number } | null {
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (kindAt(map, cx + dx, cy + dy) === Block.Pavement) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  return null;
}

/** A gang's pavement cells, where its members appear and walk. Cached per map. */
const turfCache = new WeakMap<BlockMap, Map<number, { x: number; y: number }[]>>();
function turfCells(map: BlockMap, gang: number): { x: number; y: number }[] {
  let byGang = turfCache.get(map);
  if (!byGang) turfCache.set(map, (byGang = new Map()));
  let cells = byGang.get(gang);
  if (!cells) {
    cells = pavementCells(map).filter((c) => map.territory[c.y * map.width + c.x] === gang);
    byGang.set(gang, cells);
  }
  return cells;
}

/** The middle of a gang's turf, where strays head back to. */
function turfCentre(map: BlockMap, gang: number): { x: number; y: number } {
  const cells = turfCells(map, gang);
  if (cells.length === 0) return { x: map.width / 2, y: map.height / 2 };
  return {
    x: Math.round(cells.reduce((sum, c) => sum + c.x, 0) / cells.length),
    y: Math.round(cells.reduce((sum, c) => sum + c.y, 0) / cells.length),
  };
}

/** Every pavement cell, where new pedestrians can appear. Cached per map. */
const pavementCache = new WeakMap<BlockMap, { x: number; y: number }[]>();
function pavementCells(map: BlockMap): { x: number; y: number }[] {
  let cells = pavementCache.get(map);
  if (!cells) {
    cells = [];
    for (let i = 0; i < map.kinds.length; i++) {
      if (map.kinds[i] === Block.Pavement) cells.push({ x: i % map.width, y: Math.floor(i / map.width) });
    }
    pavementCache.set(map, cells);
  }
  return cells;
}

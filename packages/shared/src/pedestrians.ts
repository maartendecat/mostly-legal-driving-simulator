import { Block, DIRECTIONS, Lane, kindAt, laneAt, type BlockMap } from './map';
import { nextRandom, randomInt, randomPick, wrapAngle } from './math';
import { secondsToTicks } from './time';
import { carSpeed, pedCollides, spawnPed, type Ped, type World } from './world';

/**
 * Pedestrians: the people walking around the city. They stroll along the pavements cell by cell,
 * turn at corners, stop now and then, and sometimes cross the road (after checking for traffic).
 * Gunfire, explosions, bodies or a car speeding at them make them run away for a while. They can
 * be shot and run over; bodies are cleared after a while and new pedestrians appear out of sight.
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
  /** Ticks without getting closer to the target. */
  stuckTicks: number;
}

const WALK_SPEED = 1.4;
/** Crossing the road: a brisk walk, to spend less time in front of traffic. */
const CROSSING_SPEED = 2.2;
const RUN_SPEED = 3.2;
/** How quickly they turn to face where they're going, in radians per second. */
const TURN_RATE = 7;
const PANIC_TICKS = secondsToTicks(4);
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

export function isPedestrian(ped: Ped): boolean {
  return ped.kind === 'pedestrian';
}

/** Adds a pedestrian standing at the centre of a pavement cell. */
export function spawnPedestrian(world: World, cx: number, cy: number): Ped {
  const ped = spawnPed(world, cx + 0.5, cy + 0.5);
  ped.kind = 'pedestrian';
  const dir = randomInt(world, 4);
  ped.heading = DIRECTIONS[dir]!.heading;
  ped.ai = { dir, target: { x: cx + 0.5, y: cy + 0.5 }, waitTicks: 0, panicTicks: 0, panicFrom: null, panicPath: null, crossing: false, stuckTicks: 0 };
  return ped;
}

/** Moves every pedestrian for one tick. Runs after projectiles, so it sees this tick's events. */
export function stepPedestrians(world: World, dt: number): void {
  for (const ped of world.peds.values()) {
    const ai = ped.ai;
    if (!ai || ped.respawnAt !== null || ped.carId !== null) continue;
    noticeDanger(world, ped, ai);
    walk(world, ped, ai, dt);
  }
}

/** Keeps the number of (living) pedestrians at the world's target, adding at most one per tick. */
export function maintainPedestrians(world: World): void {
  if (world.pedestrianTarget <= 0) return;
  let count = 0;
  for (const ped of world.peds.values()) if (ped.kind === 'pedestrian' && ped.respawnAt === null) count++;
  if (count >= world.pedestrianTarget) return;
  const cells = pavementCells(world.map);
  if (cells.length === 0) return;
  const cell = randomPick(world, cells);
  const x = cell.x + 0.5;
  const y = cell.y + 0.5;
  for (const ped of world.peds.values()) {
    if (ped.kind === 'player' && Math.hypot(ped.x - x, ped.y - y) < SPAWN_DISTANCE_FROM_PLAYERS) return;
  }
  for (const car of world.cars.values()) if (Math.hypot(car.x - x, car.y - y) < 1) return;
  spawnPedestrian(world, cell.x, cell.y);
}

function noticeDanger(world: World, ped: Ped, ai: PedestrianState): void {
  let source: { x: number; y: number } | null = null;
  let path: { x: number; y: number } | null = null;
  const near = (x: number, y: number) => Math.hypot(x - ped.x, y - ped.y) < PANIC_RADIUS;
  // Impacts, explosions, deaths, and bullets or rockets flying past.
  for (const event of world.events) {
    if (event.type !== 'carDestroyed' && near(event.x, event.y)) source = { x: event.x, y: event.y };
  }
  for (const projectile of world.projectiles.values()) {
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
  ai.panicTicks = PANIC_TICKS;
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
  const speed = ai.panicTicks > 0 ? RUN_SPEED : ai.crossing ? CROSSING_SPEED : WALK_SPEED;
  const step = Math.min(speed * dt, distance);
  const sx = (dx / distance) * step;
  const sy = (dy / distance) * step;
  const before = distance;
  if (!pedCollides(world.map, ped.x + sx, ped.y)) ped.x += sx;
  if (!pedCollides(world.map, ped.x, ped.y + sy)) ped.y += sy;

  // Pushed off course (by a car, say) and not getting anywhere: pick somewhere else to go.
  ai.stuckTicks = Math.hypot(ai.target.x - ped.x, ai.target.y - ped.y) < before - step * 0.5 ? 0 : ai.stuckTicks + 1;
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

  // At the kerb facing the road: sometimes cross, if no traffic is coming.
  if (kindAhead(ai.dir) === Block.Road && nextRandom(world) < CROSS_CHANCE && canCross(map, cx, cy, ai.dir)) {
    if (trafficNear(world, cx, cy, ai.dir)) {
      ai.waitTicks = secondsToTicks(0.8);
      return;
    }
    ai.crossing = true;
    go(ai.dir);
    return;
  }

  // Otherwise follow the pavement: mostly straight on, sometimes turning; back only at a dead end.
  const options = [
    { dir: ai.dir, weight: 6 },
    { dir: (ai.dir + 1) % 4, weight: 2 },
    { dir: (ai.dir + 3) % 4, weight: 2 },
  ].filter((o) => kindAhead(o.dir) === Block.Pavement);
  if (options.length === 0) {
    const back = (ai.dir + 2) % 4;
    if (kindAhead(back) === Block.Pavement) go(back);
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

/** A straight crossing: a few road cells (no intersection) with pavement on the other side. */
function canCross(map: BlockMap, cx: number, cy: number, dir: number): boolean {
  const d = DIRECTIONS[dir]!;
  for (let n = 1; n <= 5; n++) {
    const x = cx + d.dx * n;
    const y = cy + d.dy * n;
    const kind = kindAt(map, x, y);
    if (kind === Block.Pavement) return n > 1;
    if (kind !== Block.Road || laneAt(map, x, y) & Lane.Intersection) return false;
  }
  return false;
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

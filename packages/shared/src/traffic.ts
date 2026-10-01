import { NO_INPUT, type PlayerInput } from './input';
import { Block, DIRECTIONS, Lane, laneAt, type BlockMap } from './map';
import { nextRandom, randomPick, wrapAngle } from './math';
import { fireTruckInput, isFireTruck } from './fire';
import { pursuitInput } from './police';
import { secondsToTicks } from './time';
import { CAR_MODELS } from './vehicles';
import { spawnCar, spawnRandomCar, type Car, type Ped, type World } from './world';

/**
 * City traffic: cars that drive themselves along the lanes of the map. A traffic car is steered by
 * producing the same controls a player would press, so it follows exactly the same physics. It
 * keeps a short route of waypoints along its lane, picks a random way at each intersection, brakes
 * for anything in front of it, waits while another car is crossing an intersection, and backs up
 * when it gets stuck.
 */

/** A point to drive towards, and the lane direction (index into DIRECTIONS) from there on. */
export interface TrafficWaypoint {
  x: number;
  y: number;
  dir: number;
}

export interface TrafficState {
  route: TrafficWaypoint[];
  /** Ticks spent wanting to move without moving. */
  stuckTicks: number;
  /** While above zero, backing up to get unstuck. */
  reverseTicks: number;
  /** Ticks spent stopped behind something. */
  blockedTicks: number;
  /** While overtaking: the car or ped being passed (not a reason to brake), until it's behind us. */
  passing: number | null;
  /** A police car chasing a wanted player (see police.ts); `route` is then its way to them. */
  pursuing: number | null;
  /** A fire truck heading for a burning wreck (see fire.ts), how long it's been on its way, and how long it's been spraying. */
  fire: number | null;
  missionTicks: number;
  sprayTicks: number;
  /** A fire truck driving back to its station afterwards: a point far away, out of sight. */
  goingHome: { x: number; y: number } | null;
}

const CRUISE_SPEED = 4.5;
const TURN_SPEED = 2.6;
/** How far ahead (in blocks) the driver aims along its route. */
const AIM_DISTANCE = 1.1;
const WAYPOINT_REACHED = 0.7;
const STUCK_TICKS = secondsToTicks(1.5);
const REVERSE_TICKS = secondsToTicks(0.8);
/** Stopped behind a parked car (or a wreck, or someone standing in the road) this long: go around it. */
const OVERTAKE_AFTER_TICKS = secondsToTicks(0.75);
/** Stopped behind anything this long (say two cars blocking each other): back up and try again. */
const GIVE_WAY_AFTER_TICKS = secondsToTicks(4);
/** New traffic only appears this far (in blocks) from every player, so nobody sees it pop in. */
const SPAWN_DISTANCE_FROM_PLAYERS = 14;
const SPAWN_CLEARANCE = 3;

/**
 * Intersection routes for a car arriving heading east, as offsets from the intersection's centre,
 * and how many quarter turns (counter-clockwise) the exit direction is from the arrival direction.
 * Traffic drives on the right: eastbound in the south row, northbound in the east column, etc.
 */
const TURNS = [
  { turn: 0, points: [[2.5, -1]], weight: 2 }, // straight on
  { turn: 1, points: [[1, -1], [1, 2.5]], weight: 1 }, // left, into the northbound column
  { turn: 3, points: [[-1, -1], [-1, -2.5]], weight: 1 }, // right, into the southbound column
] as const;

/** Makes a car drive itself from where it is. Returns false if it isn't on a traffic lane. */
export function startTraffic(world: World, car: Car): boolean {
  const start = nearestLane(world.map, car);
  if (!start) {
    car.traffic = null;
    return false;
  }
  car.traffic = { route: [start], stuckTicks: 0, reverseTicks: 0, blockedTicks: 0, passing: null, pursuing: car.traffic?.pursuing ?? null, fire: car.traffic?.fire ?? null, missionTicks: car.traffic?.missionTicks ?? 0, sprayTicks: 0, goingHome: car.traffic?.goingHome ?? null };
  return true;
}

/** This tick's controls for a traffic car. May drop the car out of traffic (e.g. when it's on fire). */
export function trafficInput(world: World, car: Car): PlayerInput {
  const traffic = car.traffic;
  if (!traffic) return NO_INPUT;
  if (car.explodeAt !== null || car.wrecked) {
    car.traffic = null; // the driver bails out
    return NO_INPUT;
  }
  if (traffic.pursuing !== null) return pursuitInput(world, car, traffic);
  if (traffic.fire !== null || traffic.goingHome) return fireTruckInput(world, car, traffic);
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  const forward = car.vx * cos + car.vy * sin;

  if (traffic.reverseTicks > 0) {
    traffic.reverseTicks--;
    if (traffic.reverseTicks === 0 && !startTraffic(world, car)) return NO_INPUT;
    return { ...NO_INPUT, down: true };
  }

  // Drop waypoints we've reached or passed, then make sure there's road ahead to aim at.
  while (traffic.route.length > 1) {
    const [next] = traffic.route;
    const dx = next!.x - car.x;
    const dy = next!.y - car.y;
    const distance = Math.hypot(dx, dy);
    if (distance < WAYPOINT_REACHED || (dx * cos + dy * sin < 0 && distance < 1.5)) traffic.route.shift();
    else break;
  }
  if (!extendRoute(world, traffic)) {
    car.traffic = null;
    return NO_INPUT;
  }
  const aim = traffic.route.find((p) => Math.hypot(p.x - car.x, p.y - car.y) >= AIM_DISTANCE) ?? traffic.route.at(-1)!;
  if (Math.hypot(aim.x - car.x, aim.y - car.y) > 5) {
    // Knocked far off its route: find a lane again (or give up and stay parked).
    startTraffic(world, car);
    return NO_INPUT;
  }

  const turnNeeded = wrapAngle(Math.atan2(aim.y - car.y, aim.x - car.x) - car.heading);
  let speed = Math.abs(turnNeeded) > 0.35 ? TURN_SPEED : CRUISE_SPEED;
  if (traffic.passing !== null && isBehind(world, car, traffic.passing)) traffic.passing = null;
  const blocker = blockedAhead(world, car, forward, traffic.passing);
  if (blocker || mustYield(world, car, traffic)) speed = 0;

  // Something in the way that isn't going anywhere: drive around it through the middle of the road.
  traffic.blockedTicks = blocker ? traffic.blockedTicks + 1 : 0;
  if (blocker && isStationaryObstacle(blocker) && traffic.blockedTicks > OVERTAKE_AFTER_TICKS && planOvertake(world, car, traffic, blocker)) {
    traffic.blockedTicks = 0;
  } else if (traffic.blockedTicks > GIVE_WAY_AFTER_TICKS) {
    traffic.blockedTicks = 0;
    traffic.reverseTicks = REVERSE_TICKS;
  }

  // Stuck: wanting to go, but not going anywhere for a while. Back up, then try again.
  if (speed > 0 && Math.abs(forward) < 0.3) traffic.stuckTicks++;
  else traffic.stuckTicks = 0;
  if (traffic.stuckTicks > STUCK_TICKS) {
    traffic.stuckTicks = 0;
    traffic.reverseTicks = REVERSE_TICKS;
  }

  return {
    ...NO_INPUT,
    left: turnNeeded > 0.03,
    right: turnNeeded < -0.03,
    up: forward < speed - 0.3,
    // Brake when too fast, but never start reversing by accident.
    down: forward > speed + 0.8 || (speed === 0 && forward > 0.3),
  };
}

/**
 * Keeps the number of traffic cars, and of police cars among them, at the world's targets, adding
 * at most one per tick.
 */
export function maintainTraffic(world: World): void {
  if (world.trafficTarget <= 0 && world.policeCarTarget <= 0) return;
  let count = 0;
  let police = 0;
  for (const car of world.cars.values()) {
    if (car.traffic && car.police) police++;
    else if (car.traffic && !isFireTruck(car)) count++;
  }
  const addPolice = police < world.policeCarTarget;
  if (count >= world.trafficTarget && !addPolice) return;
  // Cars that dropped out of traffic stay behind as parked cars; don't let the city fill up with them.
  if (world.cars.size >= world.map.carSpawns.length + (world.trafficTarget + world.policeCarTarget) * 2) return;

  const cells = laneCells(world.map);
  if (cells.length === 0) return;
  const cell = randomPick(world, cells);
  const clear = (e: { x: number; y: number }, distance: number) => Math.hypot(e.x - cell.x, e.y - cell.y) > distance;
  if (![...world.cars.values()].every((c) => clear(c, SPAWN_CLEARANCE))) return;
  if (![...world.peds.values()].every((p) => clear(p, SPAWN_DISTANCE_FROM_PLAYERS))) return;
  const heading = DIRECTIONS[cell.dir]!.heading;
  const car = addPolice ? spawnCar(world, 'sedan', cell.x, cell.y, heading) : spawnRandomCar(world, { x: cell.x, y: cell.y, heading });
  if (addPolice) Object.assign(car, { police: true, color: 0xffffff });
  startTraffic(world, car);
}

/** No player within this many blocks: things can appear and disappear there unnoticed. */
const OUT_OF_SIGHT = 16;

/** No player within OUT_OF_SIGHT blocks of (x, y). */
export function outOfSight(world: World, x: number, y: number): boolean {
  for (const ped of world.peds.values()) {
    if (ped.kind === 'player' && Math.hypot(ped.x - x, ped.y - y) < OUT_OF_SIGHT) return false;
  }
  return true;
}

/**
 * A random lane cell between `minDistance` and `maxDistance` from (x, y), out of every player's
 * sight and clear of other cars: where fire trucks and police reinforcements set out from.
 */
export function hiddenLaneNear(world: World, x: number, y: number, minDistance: number, maxDistance: number): TrafficWaypoint | null {
  const cells = laneCells(world.map).filter((cell) => {
    const distance = Math.hypot(cell.x - x, cell.y - y);
    if (distance < minDistance || distance > maxDistance || !outOfSight(world, cell.x, cell.y)) return false;
    for (const car of world.cars.values()) if (Math.hypot(car.x - cell.x, car.y - cell.y) < SPAWN_CLEARANCE) return false;
    return true;
  });
  return cells.length > 0 ? randomPick(world, cells) : null;
}

/** Appends waypoints until the route runs at least three points ahead. False at a dead end. */
function extendRoute(world: World, traffic: TrafficState): boolean {
  const map = world.map;
  while (traffic.route.length < 3) {
    const last = traffic.route.at(-1)!;
    const d = DIRECTIONS[last.dir]!;
    const cx = Math.floor(last.x) + d.dx;
    const cy = Math.floor(last.y) + d.dy;
    const lane = laneAt(map, cx, cy);
    if (lane & (1 << last.dir)) {
      traffic.route.push({ x: cx + 0.5, y: cy + 0.5, dir: last.dir });
    } else if (lane & Lane.Intersection) {
      const through = chooseWayThrough(world, Math.floor(last.x), Math.floor(last.y), last.dir);
      if (!through) return false;
      traffic.route.push(...through);
    } else {
      return false;
    }
  }
  return true;
}

/** Picks a random way through the intersection ahead of lane cell (cx, cy) heading `dir`. */
function chooseWayThrough(world: World, cx: number, cy: number, dir: number): TrafficWaypoint[] | null {
  const center = intersectionCenter(cx, cy, dir);
  const angle = DIRECTIONS[dir]!.heading;
  const cos = Math.round(Math.cos(angle));
  const sin = Math.round(Math.sin(angle));
  const options = TURNS.map(({ turn, points, weight }) => {
    const exitDir = (dir + turn) % 4;
    const route = points.map(([ox, oy]) => ({ x: center.x + ox * cos - oy * sin, y: center.y + ox * sin + oy * cos, dir: exitDir }));
    const exit = route.at(-1)!;
    const valid = (laneAt(world.map, Math.floor(exit.x), Math.floor(exit.y)) & (1 << exitDir)) !== 0;
    return { route, weight: valid ? weight : 0 };
  }).filter((o) => o.weight > 0);
  if (options.length === 0) return null;
  let roll = nextRandom(world) * options.reduce((sum, o) => sum + o.weight, 0);
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.route;
  }
  return options.at(-1)!.route;
}

/**
 * The centre of the intersection just ahead of lane cell (cx, cy) heading `dir`: two cells ahead,
 * one to the left (the lane is on the right-hand side of the road).
 */
function intersectionCenter(cx: number, cy: number, dir: number): { x: number; y: number } {
  const d = DIRECTIONS[dir]!;
  return { x: cx + 2 * d.dx - d.dy + 0.5, y: cy + 2 * d.dy + d.dx + 0.5 };
}

type Obstacle = { kind: 'car'; car: Car } | { kind: 'ped'; ped: Ped };

/**
 * Parked cars, wrecks and people standing around can be overtaken. Traffic isn't: it's queueing
 * (behind something, or for an intersection) and will move again.
 */
function isStationaryObstacle(obstacle: Obstacle): boolean {
  if (obstacle.kind === 'ped') return true;
  return obstacle.car.traffic === null && Math.hypot(obstacle.car.vx, obstacle.car.vy) < 0.3;
}

/**
 * Plans a way around an obstacle: swing into the middle row of the road (it's left of our lane),
 * pass it, and pull back in behind it. Fails (so we keep waiting) near intersections or when the
 * middle of the road isn't clear.
 */
function planOvertake(world: World, car: Car, traffic: TrafficState, obstacle: Obstacle): boolean {
  const dir = traffic.route[0]?.dir;
  if (dir === undefined) return false;
  const d = DIRECTIONS[dir]!;
  const left = { x: -d.dy, y: d.dx };
  // Positions along our lane line: `t` blocks ahead of the car, `side` rows to the left.
  const laneRef = traffic.route[0]!;
  const at = (t: number, side: number) => ({
    x: (d.dx !== 0 ? car.x + d.dx * t : laneRef.x) + left.x * side,
    y: (d.dy !== 0 ? car.y + d.dy * t : laneRef.y) + left.y * side,
  });
  const other = obstacle.kind === 'car' ? obstacle.car : obstacle.ped;
  const obstacleAhead = (other.x - car.x) * d.dx + (other.y - car.y) * d.dy;
  const obstacleHalf = obstacle.kind === 'car' ? CAR_MODELS[obstacle.car.model].length / 2 : 0.3;
  const passEnd = obstacleAhead + obstacleHalf + 1.3;

  // Walk ahead along the lane and the middle row: both must be road, and the middle row free of
  // cars. The obstacle must be passed before any intersection; once past it, we may carry straight
  // on through an intersection in the middle row and pull back in on the other side.
  const road = (p: { x: number; y: number }) => world.map.kinds[Math.floor(p.y) * world.map.width + Math.floor(p.x)] === Block.Road;
  const crossing = (p: { x: number; y: number }) => (laneAt(world.map, Math.floor(p.x), Math.floor(p.y)) & Lane.Intersection) !== 0;
  let backAt: number | null = null;
  let crossed = false;
  for (let t = 0.5; t < 12; t += 0.5) {
    const middle = at(t, 1);
    const lane = at(t, 0);
    if (!road(middle) || !road(lane)) return false;
    const inIntersection = crossing(middle) || crossing(lane);
    if (inIntersection && t <= passEnd) return false; // it's parked at an intersection: wait
    crossed ||= inIntersection;
    if (!inIntersection) {
      for (const c of world.cars.values()) {
        if (c !== car && Math.hypot(c.x - middle.x, c.y - middle.y) < 0.9) return false;
      }
    }
    if (t > passEnd + 1.2 && !inIntersection) {
      backAt = t;
      break;
    }
  }
  if (backAt === null) return false;
  const back = at(backAt, 0);
  const backCell = { x: Math.floor(back.x), y: Math.floor(back.y) };
  if (!(laneAt(world.map, backCell.x, backCell.y) & (1 << dir))) return false;
  traffic.route = [
    { ...at(0.9, 1), dir },
    { ...at(passEnd, 1), dir },
    ...(crossed ? [{ ...at(backAt - 0.8, 1), dir }] : []),
    { x: backCell.x + 0.5, y: backCell.y + 0.5, dir },
  ];
  traffic.passing = other.id;
  return true;
}

/** Whether car or ped `id` is gone, or fully behind the car. */
function isBehind(world: World, car: Car, id: number): boolean {
  const other = world.cars.get(id) ?? world.peds.get(id);
  if (!other) return true;
  const along = (other.x - car.x) * Math.cos(car.heading) + (other.y - car.y) * Math.sin(car.heading);
  return along < -CAR_MODELS[car.model].length;
}

/** Anything (car or ped on foot) right in front of the car, within braking distance. */
function blockedAhead(world: World, car: Car, forward: number, ignoreId: number | null): Obstacle | null {
  const m = CAR_MODELS[car.model];
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  const reach = m.length / 2 + 1.2 + Math.max(forward, 0) * 0.35;
  const inFront = (x: number, y: number, radius: number) => {
    const dx = x - car.x;
    const dy = y - car.y;
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    return along > 0 && along < reach + radius && Math.abs(across) < m.width / 2 + radius;
  };
  for (const other of world.cars.values()) {
    if (other !== car && other.id !== ignoreId && inFront(other.x, other.y, CAR_MODELS[other.model].width / 2 + 0.1)) return { kind: 'car', car: other };
  }
  for (const ped of world.peds.values()) {
    if (ped.id !== ignoreId && ped.carId === null && ped.respawnAt === null && inFront(ped.x, ped.y, 0.3)) return { kind: 'ped', ped };
  }
  return null;
}

/**
 * Right of way at intersections: cars approaching or inside one take turns, and the car nearest
 * the centre goes first (ties go to the lower id, so two cars never wait for each other forever).
 * Checked from two cells out, so there's room to stop.
 */
function mustYield(world: World, car: Car, traffic: TrafficState): boolean {
  const cx = Math.floor(car.x);
  const cy = Math.floor(car.y);
  if (laneAt(world.map, cx, cy) & Lane.Intersection) return false; // already in it: keep going
  const dir = traffic.route[0]?.dir ?? 0;
  const d = DIRECTIONS[dir]!;
  const ahead = [1, 2].find((n) => laneAt(world.map, cx + d.dx * n, cy + d.dy * n) & Lane.Intersection);
  if (ahead === undefined) return false;
  // The lane cell right before the intersection tells us where its centre is.
  const center = intersectionCenter(cx + d.dx * (ahead - 1), cy + d.dy * (ahead - 1), dir);
  const myDistance = Math.hypot(car.x - center.x, car.y - center.y);
  for (const other of world.cars.values()) {
    if (other === car || Math.hypot(other.vx, other.vy) < 0.8) continue;
    const dx = center.x - other.x;
    const dy = center.y - other.y;
    if (Math.abs(dx) > 2.6 || Math.abs(dy) > 2.6) continue;
    const inside = Math.abs(dx) < 1.6 && Math.abs(dy) < 1.6;
    const approaching = other.vx * dx + other.vy * dy > 0;
    if (!inside && !approaching) continue; // on its way out
    const distance = Math.hypot(dx, dy);
    if (distance < myDistance - 0.05 || (Math.abs(distance - myDistance) <= 0.05 && other.id < car.id)) return true;
  }
  return false;
}

/** The lane cell under (or right next to) a car, facing roughly the way the car does. */
function nearestLane(map: BlockMap, car: Car): TrafficWaypoint | null {
  let best: TrafficWaypoint | null = null;
  let bestDistance = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = Math.floor(car.x) + dx;
      const cy = Math.floor(car.y) + dy;
      const lane = laneAt(map, cx, cy);
      for (let dir = 0; dir < 4; dir++) {
        if (!(lane & (1 << dir))) continue;
        const facing = Math.cos(wrapAngle(DIRECTIONS[dir]!.heading - car.heading));
        const distance = Math.hypot(cx + 0.5 - car.x, cy + 0.5 - car.y);
        if (facing > 0.3 && distance < bestDistance) {
          best = { x: cx + 0.5, y: cy + 0.5, dir };
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

/** Every one-way lane cell (not intersections), where new traffic can start. Cached per map. */
const laneCellCache = new WeakMap<BlockMap, TrafficWaypoint[]>();
export function laneCells(map: BlockMap): TrafficWaypoint[] {
  let cells = laneCellCache.get(map);
  if (!cells) {
    cells = [];
    for (let i = 0; i < map.lanes.length; i++) {
      const lane = map.lanes[i]!;
      const dir = [Lane.East, Lane.North, Lane.West, Lane.South].indexOf(lane as 1 | 2 | 4 | 8);
      if (dir >= 0) cells.push({ x: (i % map.width) + 0.5, y: Math.floor(i / map.width) + 0.5, dir });
    }
    laneCellCache.set(map, cells);
  }
  return cells;
}

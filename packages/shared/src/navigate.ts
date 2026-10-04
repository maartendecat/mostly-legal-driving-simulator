import { NO_INPUT, type PlayerInput } from './input';
import { Block, kindAt, lineOfSight, type BlockMap } from './map';
import { wrapAngle } from './math';
import { secondsToTicks } from './time';
import type { TrafficState } from './traffic';
import type { Car, World } from './world';

/**
 * Driving somewhere off the traffic routes: police cars chasing someone, fire trucks heading for a
 * fire. Straight there when there's a clear view, otherwise along the roads.
 */

/** How often a car works out its way along the roads again (its target may have moved). */
const REPLAN_TICKS = 30;
const STUCK_TICKS = secondsToTicks(1);
const REVERSE_TICKS = secondsToTicks(0.8);
/** Turning more than this (radians) to face where it's going: crawl round at this speed. */
const SHARP_TURN = 1.2;
const CRAWL_SPEED = 2;

/** The car's speed along its heading (negative when reversing). */
export function forwardSpeed(car: Car): number {
  return car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading);
}

/**
 * This tick's controls to drive towards (x, y) at up to `speed` (`turnSpeed` in sharp turns):
 * straight at it when it's in plain sight, otherwise along the road path (kept in `traffic.route`).
 * It slows down for turns (cars keep their speed through them), and when stuck it backs up for a
 * moment, swinging its nose round towards where it's going, and tries again.
 */
export function driveTowards(world: World, car: Car, traffic: TrafficState, x: number, y: number, speed: number, turnSpeed: number): PlayerInput {
  const forward = forwardSpeed(car);
  let aim = { x, y };
  if (!lineOfSight(world.map, car.x, car.y, x, y)) {
    if (traffic.route.length === 0 || world.tick % REPLAN_TICKS === car.id % REPLAN_TICKS) {
      traffic.route = roadPath(world.map, car.x, car.y, x, y).map((p) => ({ ...p, dir: 0 }));
    }
    while (traffic.route.length > 1 && Math.hypot(traffic.route[0]!.x - car.x, traffic.route[0]!.y - car.y) < 1.5) traffic.route.shift();
    if (traffic.route.length > 0) aim = traffic.route[0]!;
  } else {
    traffic.route = [];
  }
  const turnNeeded = wrapAngle(Math.atan2(aim.y - car.y, aim.x - car.x) - car.heading);

  if (traffic.reverseTicks > 0) {
    // Backing up, steering the other way round, so the nose swings towards where it's going.
    traffic.reverseTicks--;
    return { ...NO_INPUT, down: true, left: turnNeeded < -0.1, right: turnNeeded > 0.1 };
  }
  // Cars keep their speed through turns (see driveCar), so slow down for them: a lot for sharp ones.
  const sharpness = Math.abs(turnNeeded);
  const wanted = sharpness > SHARP_TURN ? Math.min(turnSpeed, CRAWL_SPEED) : sharpness > 0.5 ? turnSpeed : speed;
  if (Math.abs(forward) < 0.3) traffic.stuckTicks++;
  else traffic.stuckTicks = 0;
  if (traffic.stuckTicks > STUCK_TICKS) {
    traffic.stuckTicks = 0;
    traffic.reverseTicks = REVERSE_TICKS;
  }
  return {
    ...NO_INPUT,
    left: turnNeeded > 0.05,
    right: turnNeeded < -0.05,
    up: forward < wanted - 0.3,
    down: forward > wanted + 0.8,
  };
}

/**
 * The way along the roads (cell centres, a few apart) from one point to another: a breadth-first
 * search over road cells, from the road cell nearest the start to the one nearest the end.
 */
export function roadPath(map: BlockMap, x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const start = nearestRoad(map, Math.floor(x0), Math.floor(y0));
  const goal = nearestRoad(map, Math.floor(x1), Math.floor(y1));
  if (start === null || goal === null) return [];
  const previous = new Int32Array(map.width * map.height).fill(-1);
  previous[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length && previous[goal] === -1; head++) {
    const cell = queue[head]!;
    const cx = cell % map.width;
    const cy = Math.floor(cell / map.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      const next = ny * map.width + nx;
      if (kindAt(map, nx, ny) !== Block.Road || previous[next] !== -1) continue;
      previous[next] = cell;
      queue.push(next);
    }
  }
  if (previous[goal] === -1) return [];
  const cells: number[] = [];
  for (let cell = goal; cell !== start; cell = previous[cell]!) cells.push(cell);
  cells.reverse();
  // Every other cell is plenty to steer by.
  return cells.filter((_, i) => i % 2 === 1 || i === cells.length - 1).map((cell) => ({ x: (cell % map.width) + 0.5, y: Math.floor(cell / map.width) + 0.5 }));
}

function nearestRoad(map: BlockMap, cx: number, cy: number): number | null {
  for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (kindAt(map, cx + dx, cy + dy) === Block.Road) return (cy + dy) * map.width + cx + dx;
      }
    }
  }
  return null;
}

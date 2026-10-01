import { isDead } from './damage';
import { NO_INPUT, type PlayerInput } from './input';
import { Block, kindAt, lineOfSight, type BlockMap } from './map';
import { wrapAngle } from './math';
import { ejectDriver } from './pedestrians';
import { secondsToTicks } from './time';
import { startTraffic, type TrafficState } from './traffic';
import { carSpeed, type Car, type Ped, type World } from './world';

/**
 * The police (a first part; the full design, with escalation up to the army, is still to come).
 *
 * Cops walk the city and police cars drive around in the traffic. A player who rams a police car,
 * or hurts a cop or a police car, or steals one, is wanted: police cars nearby give chase with
 * their lights flashing, and cops nearby run after them. Once the suspect stops (or is on foot),
 * a chasing police car pulls up and its two cops jump out. A cop who reaches a player on foot, or
 * in a car that has stopped, arrests them: BUSTED. They lose their weapons and come back a moment
 * later somewhere else. Staying out of sight of the police for a while makes them give up.
 */

/** A player the police are after, until when (unless the police see them again before that). */
export interface WantedRecord {
  pedId: number;
  until: number;
}

/** How long the police keep looking for someone they've lost sight of. */
export const WANTED_TICKS = secondsToTicks(30);
/** Cops and police cars see a wanted player from this far (in blocks), in plain sight. */
const POLICE_SIGHT = 12;
/** Police cars this close to a wanted player join the chase. */
const PURSUIT_RANGE = 20;
/** A chasing police car drives at up to this speed (blocks/s), slower in turns. */
const PURSUIT_SPEED = 10;
const PURSUIT_TURN_SPEED = 4;
/** Pulls up when the suspect is this close and (nearly) standing still, then the cops get out. */
const PULL_UP_DISTANCE = 4;
const SUSPECT_STOPPED_SPEED = 2;
/** How often a chasing car works out its way to the suspect along the roads. */
const REPLAN_TICKS = 30;
const STUCK_TICKS = secondsToTicks(1);
const REVERSE_TICKS = secondsToTicks(0.8);
/** A car going slower than this can be arrested out of. */
export const ARRESTABLE_CAR_SPEED = 1;
/** Taken away for this long before they're back (as long as a respawn after dying). */
export const BUSTED_TICKS = secondsToTicks(3);

/** A crime by `offenderId` (if they're a player): the police are after them, starting now. */
export function reportCrime(world: World, offenderId: number | null): void {
  const offender = offenderId === null ? undefined : world.peds.get(offenderId);
  if (!offender || offender.kind !== 'player' || isDead(offender)) return;
  const until = world.tick + WANTED_TICKS;
  const record = world.wanted.find((w) => w.pedId === offender.id);
  if (record) {
    record.until = Math.max(record.until, until);
    return;
  }
  world.wanted.push({ pedId: offender.id, until });
  offender.wanted = 1;
  world.events.push({ type: 'wanted', tick: world.tick, ownerId: offender.id, pedId: offender.id, level: 1, x: offender.x, y: offender.y });
}

/** Whether the police are after this ped. */
export function isWanted(ped: Ped): boolean {
  return ped.wanted > 0;
}

/** A cop arrests a player: out of their car, weapons gone, back somewhere else in a moment. */
export function bust(world: World, suspect: Ped, cop: Ped): void {
  const car = suspect.carId === null ? undefined : world.cars.get(suspect.carId);
  if (car && car.driverId === suspect.id) car.driverId = null;
  Object.assign(suspect, { carId: null, weapon: null, ammo: {}, fireCooldown: 0, respawnAt: world.tick + BUSTED_TICKS, wanted: 0 });
  world.wanted = world.wanted.filter((w) => w.pedId !== suspect.id);
  world.events.push({ type: 'busted', tick: world.tick, ownerId: cop.id, pedId: suspect.id, copId: cop.id, x: suspect.x, y: suspect.y });
}

/** Arrested and taken away (rather than dead): out of the game until they come back. */
export function isBusted(ped: Ped): boolean {
  return ped.respawnAt !== null && ped.health > 0;
}

/** Can a cop standing next to them arrest them? On foot, or in a car that's (nearly) stopped. */
export function canArrest(world: World, suspect: Ped): boolean {
  if (isDead(suspect)) return false;
  const car = suspect.carId === null ? undefined : world.cars.get(suspect.carId);
  return !car || carSpeed(car) < ARRESTABLE_CAR_SPEED;
}

/**
 * Once per tick: the police keep (or lose) track of wanted players, and police cars join or leave
 * chases. Dying, or getting busted, wipes the slate clean.
 */
export function stepPolice(world: World): void {
  if (world.wanted.length > 0) {
    world.wanted = world.wanted.filter((record) => {
      const ped = world.peds.get(record.pedId);
      if (!ped) return false;
      if (!isDead(ped) && seenByPolice(world, ped)) record.until = Math.max(record.until, world.tick + WANTED_TICKS);
      if (isDead(ped) || world.tick >= record.until) {
        ped.wanted = 0;
        return false;
      }
      return true;
    });
  }
  for (const car of world.cars.values()) {
    const traffic = car.traffic;
    if (!car.police || !traffic) continue;
    if (traffic.pursuing !== null) {
      const suspect = world.peds.get(traffic.pursuing);
      if (suspect && isWanted(suspect)) continue;
      // Gave up (or got them): back to driving around.
      car.siren = false;
      traffic.pursuing = null;
      startTraffic(world, car);
      continue;
    }
    const suspect = nearestWanted(world, car.x, car.y, PURSUIT_RANGE);
    if (suspect) {
      traffic.pursuing = suspect.id;
      traffic.route = [];
      traffic.stuckTicks = traffic.reverseTicks = 0;
      car.siren = true;
    }
  }
}

/** The nearest wanted player within `range`, if any. */
export function nearestWanted(world: World, x: number, y: number, range: number): Ped | undefined {
  let best: Ped | undefined;
  let bestDistance = range;
  for (const record of world.wanted) {
    const ped = world.peds.get(record.pedId);
    if (!ped || isDead(ped)) continue;
    const distance = Math.hypot(ped.x - x, ped.y - y);
    if (distance < bestDistance) {
      best = ped;
      bestDistance = distance;
    }
  }
  return best;
}

/** Any cop on foot, or crewed police car, that can see them. */
function seenByPolice(world: World, ped: Ped): boolean {
  const sees = (x: number, y: number) => Math.hypot(x - ped.x, y - ped.y) < POLICE_SIGHT && lineOfSight(world.map, x, y, ped.x, ped.y);
  for (const other of world.peds.values()) {
    if (other.kind === 'cop' && !isDead(other) && other.carId === null && sees(other.x, other.y)) return true;
  }
  for (const car of world.cars.values()) {
    if (car.police && car.traffic && sees(car.x, car.y)) return true;
  }
  return false;
}

/**
 * This tick's controls for a police car chasing `traffic.pursuing`: straight at them when it can
 * see them, otherwise along the roads; pulling up next to them once they've stopped, and sending
 * its cops out.
 */
export function pursuitInput(world: World, car: Car, traffic: TrafficState): PlayerInput {
  const suspect = traffic.pursuing === null ? undefined : world.peds.get(traffic.pursuing);
  if (!suspect) return NO_INPUT;
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  const forward = car.vx * cos + car.vy * sin;
  if (traffic.reverseTicks > 0) {
    traffic.reverseTicks--;
    return { ...NO_INPUT, down: true, left: traffic.reverseTicks % 40 < 20 };
  }

  const suspectCar = suspect.carId === null ? undefined : world.cars.get(suspect.carId);
  const suspectSpeed = suspectCar ? carSpeed(suspectCar) : 0;
  const distance = Math.hypot(suspect.x - car.x, suspect.y - car.y);
  if (distance < PULL_UP_DISTANCE && suspectSpeed < SUSPECT_STOPPED_SPEED) {
    if (Math.abs(forward) > 1) return { ...NO_INPUT, down: forward > 0, up: forward < 0 };
    // Stopped next to them: both cops get out and go for the arrest; the car stays where it is.
    ejectDriver(world, car, suspect, 'cop', 1);
    ejectDriver(world, car, suspect, 'cop', -1);
    car.traffic = null;
    car.siren = false;
    return NO_INPUT;
  }

  // Aim straight at them when there's a clear view; otherwise follow the roads towards them.
  let aim = { x: suspect.x, y: suspect.y };
  if (!lineOfSight(world.map, car.x, car.y, suspect.x, suspect.y)) {
    if (traffic.route.length === 0 || world.tick % REPLAN_TICKS === car.id % REPLAN_TICKS) {
      traffic.route = roadPath(world.map, car.x, car.y, suspect.x, suspect.y).map((p) => ({ ...p, dir: 0 }));
    }
    while (traffic.route.length > 1 && Math.hypot(traffic.route[0]!.x - car.x, traffic.route[0]!.y - car.y) < 1.5) traffic.route.shift();
    if (traffic.route.length > 0) aim = traffic.route[0]!;
  } else {
    traffic.route = [];
  }

  const turnNeeded = wrapAngle(Math.atan2(aim.y - car.y, aim.x - car.x) - car.heading);
  const speed = Math.abs(turnNeeded) > 0.5 ? PURSUIT_TURN_SPEED : PURSUIT_SPEED;
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
    up: forward < speed - 0.3,
    down: forward > speed + 0.8,
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

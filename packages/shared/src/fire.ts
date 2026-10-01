import { NO_INPUT, type PlayerInput } from './input';
import { randomPick } from './math';
import { driveTowards, forwardSpeed } from './navigate';
import { secondsToTicks } from './time';
import { laneCells, startTraffic, type TrafficState } from './traffic';
import { spawnCar, type Car, type World } from './world';
import { DIRECTIONS } from './map';

/**
 * The fire brigade. A car that blows up leaves a wreck that keeps burning for a while. For each
 * burning wreck a fire truck sets out (up to a number at a time), from out of sight: it drives
 * there with its lights flashing, stops within reach, and sprays water on the fire until it's out.
 * Then it drives back towards its station (somewhere far away) and disappears once nobody can see it. Unattended fires burn
 * out by themselves after a while.
 */

/** A wreck burns this long unless the fire brigade puts it out sooner (it's cleared away after WRECK_TICKS). */
export const WRECK_BURN_TICKS = secondsToTicks(25);
/** A fire truck sprays from this close (in blocks)... */
export const SPRAY_RANGE = 3.5;
/** ...for this long to put a fire out. */
export const EXTINGUISH_TICKS = secondsToTicks(2.5);
/** Fire trucks set out from this far from the fire (in blocks)... */
const DISPATCH_MIN_DISTANCE = 12;
const DISPATCH_MAX_DISTANCE = 40;
/** ...where no player can see them appear, and disappear again once out of sight. */
const OUT_OF_SIGHT = 16;
const SPAWN_CLEARANCE = 3;
/** How often new fires are looked for. */
const DISPATCH_EVERY_TICKS = 30;
/** A fire truck that hasn't got there in this time gives up. */
const GIVE_UP_TICKS = secondsToTicks(60);
/** Afterwards it drives off towards a road this far away (its station), at a calmer pace. */
const HOME_DISTANCE = 25;
const HOME_SPEED = 5;
const DRIVE_SPEED = 9;
const TURN_SPEED = 3.5;

export function isFireTruck(car: Car): boolean {
  return car.model === 'fireTruck';
}

/** A wreck that's still on fire. */
export function isBurningWreck(car: Car): boolean {
  return car.wrecked && car.burnsUntil !== null;
}

/**
 * Once per tick: sends fire trucks to burning wrecks nobody's dealing with, ends missions whose
 * fire is out (or gone), and takes idle trucks off the streets once out of sight.
 */
export function stepFire(world: World): void {
  if (world.fireTruckTarget <= 0) return;
  let busy = 0;
  for (const truck of [...world.cars.values()]) {
    const traffic = truck.traffic;
    if (!isFireTruck(truck) || !traffic) continue;
    if (traffic.fire !== null) {
      const fire = world.cars.get(traffic.fire);
      if (fire && isBurningWreck(fire) && traffic.missionTicks < GIVE_UP_TICKS) {
        busy++;
        continue;
      }
      // Done (or too late): back to the station, far away.
      Object.assign(truck, { siren: false, spray: null });
      traffic.fire = null;
      traffic.route = [];
      const far = laneCells(world.map).filter((cell) => Math.hypot(cell.x - truck.x, cell.y - truck.y) > HOME_DISTANCE);
      traffic.goingHome = far.length > 0 ? randomPick(world, far) : null;
      if (!traffic.goingHome) startTraffic(world, truck);
    } else if (outOfSight(world, truck.x, truck.y)) {
      world.cars.delete(truck.id);
    }
  }

  if (world.tick % DISPATCH_EVERY_TICKS !== 0 || busy >= world.fireTruckTarget) return;
  const handled = new Set<number>();
  for (const truck of world.cars.values()) if (truck.traffic?.fire != null) handled.add(truck.traffic.fire);
  for (const wreck of world.cars.values()) {
    if (busy >= world.fireTruckTarget) break;
    if (!isBurningWreck(wreck) || handled.has(wreck.id)) continue;
    if (dispatch(world, wreck)) busy++;
  }
}

/** Sends a fire truck to a burning wreck, from a lane out of every player's sight. */
function dispatch(world: World, wreck: Car): boolean {
  const cells = laneCells(world.map).filter((cell) => {
    const distance = Math.hypot(cell.x - wreck.x, cell.y - wreck.y);
    if (distance < DISPATCH_MIN_DISTANCE || distance > DISPATCH_MAX_DISTANCE) return false;
    if (!outOfSight(world, cell.x, cell.y)) return false;
    for (const car of world.cars.values()) if (Math.hypot(car.x - cell.x, car.y - cell.y) < SPAWN_CLEARANCE) return false;
    return true;
  });
  if (cells.length === 0) return false;
  const cell = randomPick(world, cells);
  const truck = spawnCar(world, 'fireTruck', cell.x, cell.y, DIRECTIONS[cell.dir]!.heading);
  truck.color = 0xd32f2f;
  startTraffic(world, truck);
  truck.traffic!.fire = wreck.id;
  truck.traffic!.route = [];
  truck.siren = true;
  return true;
}

/** No player within OUT_OF_SIGHT blocks. */
function outOfSight(world: World, x: number, y: number): boolean {
  for (const ped of world.peds.values()) {
    if (ped.kind === 'player' && Math.hypot(ped.x - x, ped.y - y) < OUT_OF_SIGHT) return false;
  }
  return true;
}

/**
 * This tick's controls for a fire truck on its way to `traffic.fire`: drive there, stop within
 * reach, and spray until the fire's out.
 */
export function fireTruckInput(world: World, truck: Car, traffic: TrafficState): PlayerInput {
  if (traffic.fire === null && traffic.goingHome) {
    const home = traffic.goingHome;
    if (Math.hypot(home.x - truck.x, home.y - truck.y) < 2) {
      traffic.goingHome = null;
      startTraffic(world, truck);
      return NO_INPUT;
    }
    return driveTowards(world, truck, traffic, home.x, home.y, HOME_SPEED, TURN_SPEED * 0.7);
  }
  const fire = traffic.fire === null ? undefined : world.cars.get(traffic.fire);
  if (!fire || !isBurningWreck(fire)) return NO_INPUT;
  traffic.missionTicks++;
  const distance = Math.hypot(fire.x - truck.x, fire.y - truck.y);
  if (distance > SPRAY_RANGE || traffic.reverseTicks > 0) {
    truck.spray = null;
    traffic.sprayTicks = 0;
    // Slowing down on the way in, so it stops at a safe distance rather than in the flames.
    const speed = Math.min(DRIVE_SPEED, Math.max(2, distance - 1));
    return driveTowards(world, truck, traffic, fire.x, fire.y, speed, Math.min(TURN_SPEED, speed));
  }
  // Within reach: stop, then water on the fire until it's out.
  const forward = forwardSpeed(truck);
  if (Math.abs(forward) > 0.5) return { ...NO_INPUT, down: forward > 0, up: forward < 0 };
  truck.spray = { x: fire.x, y: fire.y };
  if (++traffic.sprayTicks >= EXTINGUISH_TICKS) {
    extinguish(world, fire);
    truck.spray = null;
  }
  return NO_INPUT;
}

/** Puts a burning wreck out; it's cleared away a while later as usual. */
export function extinguish(world: World, wreck: Car): void {
  wreck.burnsUntil = null;
  if (wreck.removeAt !== null) wreck.removeAt = Math.max(wreck.removeAt, world.tick + secondsToTicks(10));
}

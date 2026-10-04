import { isDead } from './damage';
import { Block, DIRECTIONS, kindAt, laneAt, Lane } from './map';
import { nearestWanted } from './police';
import { spawnPedestrian } from './pedestrians';
import { hiddenLaneNear, outOfSight, startTraffic } from './traffic';
import type { CarModelId } from './vehicles';
import { carCollides, carSpeed, isLaw, spawnCar, type Car, type Ped, type World } from './world';
import { CAR_MODELS } from './vehicles';
import { secondsToTicks } from './time';

/**
 * Who the police send, by wanted level (see docs/POLICE.md): police cars from one star, more of
 * them from two; roadblocks ahead of a driving suspect from three; SWAT vans from four; the army
 * (a tank and a troop truck, plus a helicopter, see helicopter.ts) at six. Units appear out of
 * every player's sight, chase the most wanted player they're meant for, and disappear again (out
 * of sight) once they're no longer needed. Patrol police cars stay.
 */

export type UnitKind = 'police' | 'swat' | 'armyTruck' | 'tank';

/** Each unit: its vehicle, its colour, and the fewest stars a suspect needs before it comes after them. */
export const UNITS: Record<UnitKind, { model: CarModelId; color: number; minLevel: number; crew: 'cop' | 'swat' | 'soldier'; crewSize: number }> = {
  police: { model: 'sedan', color: 0xffffff, minLevel: 1, crew: 'cop', crewSize: 2 },
  swat: { model: 'swatVan', color: 0x1f2a44, minLevel: 4, crew: 'swat', crewSize: 4 },
  armyTruck: { model: 'armyTruck', color: 0x556b2f, minLevel: 6, crew: 'soldier', crewSize: 4 },
  tank: { model: 'tank', color: 0x4b5d3a, minLevel: 6, crew: 'soldier', crewSize: 0 },
};
/** Extra units per wanted player, by their level (index = stars), and at most per room. */
const PER_LEVEL: Record<UnitKind, readonly number[]> = {
  police: [0, 0, 2, 4, 4, 4, 4],
  swat: [0, 0, 0, 0, 1, 2, 2],
  armyTruck: [0, 0, 0, 0, 0, 0, 1],
  tank: [0, 0, 0, 0, 0, 0, 1],
};
const ROOM_MAX: Record<UnitKind, number> = { police: 8, swat: 3, armyTruck: 2, tank: 1 };
/** The order units are sent in when several are missing: the heaviest first. */
const DISPATCH_ORDER: UnitKind[] = ['tank', 'armyTruck', 'swat', 'police'];
/** At one star only police cars this close join the chase; from two stars, all of them. */
const PURSUIT_RANGE = 20;
/** New units appear on a road this far from the suspect (out of every player's sight)... */
const DISPATCH_MIN_DISTANCE = 15;
const DISPATCH_MAX_DISTANCE = 40;
/** ...at most one every half second. */
const DISPATCH_EVERY_TICKS = 30;

/** Roadblocks: from this many stars, for a suspect driving faster than this (blocks/s)... */
const ROADBLOCK_LEVEL = 3;
const ROADBLOCK_MIN_SPEED = 4;
/** ...this far ahead of them on their road, out of sight... */
const ROADBLOCK_MIN_AHEAD = 18;
const ROADBLOCK_MAX_AHEAD = 32;
/** ...one per suspect and two per room at a time, each lasting this long. */
const ROADBLOCKS_PER_ROOM = 2;
const ROADBLOCK_TICKS = secondsToTicks(45);
const ROADBLOCK_EVERY_TICKS = 60;

/** Two police cars parked across a road ahead of a suspect, with their cops (see maintainRoadblocks). */
export interface Roadblock {
  pedId: number;
  carIds: number[];
  until: number;
}

/** Which kind of unit a car is, if it's one (police cars, SWAT vans, army trucks, tanks). */
export function unitKind(car: Car): UnitKind | null {
  if (!car.police) return null;
  if (car.model === 'swatVan') return 'swat';
  if (car.model === 'armyTruck') return 'armyTruck';
  if (car.model === 'tank') return 'tank';
  return 'police';
}

/** Once per tick, after the wanted levels are up to date: chases, new units, roadblocks, clearing up. */
export function deployUnits(world: World): void {
  assignPursuits(world);
  dispatch(world);
  maintainRoadblocks(world);
  clearUp(world);
}

/** Crewed units go after the nearest suspect they're meant for, and let go when that's over. */
function assignPursuits(world: World): void {
  for (const car of world.cars.values()) {
    const traffic = car.traffic;
    const kind = unitKind(car);
    if (!kind || !traffic) continue;
    const minLevel = UNITS[kind].minLevel;
    if (traffic.pursuing !== null) {
      const suspect = world.peds.get(traffic.pursuing);
      if (suspect && !isDead(suspect) && suspect.wanted >= minLevel) continue;
      // Gave up (or got them): back to driving around (and off the streets once out of sight).
      car.siren = false;
      traffic.pursuing = null;
      startTraffic(world, car);
      continue;
    }
    const suspect = nearestWanted(world, car.x, car.y, Infinity, minLevel);
    if (!suspect) continue;
    if (kind === 'police' && suspect.wanted < 2 && Math.hypot(suspect.x - car.x, suspect.y - car.y) > PURSUIT_RANGE) continue;
    traffic.pursuing = suspect.id;
    traffic.route = [];
    traffic.stuckTicks = traffic.reverseTicks = 0;
    car.siren = true;
  }
}

/** How many units of each kind should be out now (patrol police cars included). */
function unitsNeeded(world: World): Record<UnitKind, number> {
  const needed: Record<UnitKind, number> = { police: 0, swat: 0, armyTruck: 0, tank: 0 };
  for (const record of world.wanted) {
    const ped = world.peds.get(record.pedId);
    if (!ped || isDead(ped)) continue;
    for (const kind of DISPATCH_ORDER) needed[kind] += PER_LEVEL[kind][ped.wanted] ?? 0;
  }
  for (const kind of DISPATCH_ORDER) needed[kind] = Math.min(needed[kind], ROOM_MAX[kind]);
  needed.police += world.policeCarTarget;
  return needed;
}

/**
 * Sends a missing unit (the heaviest first), near the most wanted player it's for; or takes an
 * idle one that's no longer needed off the streets, once nobody can see it.
 */
function dispatch(world: World): void {
  const needed = unitsNeeded(world);
  const crewed: Record<UnitKind, Car[]> = { police: [], swat: [], armyTruck: [], tank: [] };
  for (const car of world.cars.values()) {
    const kind = unitKind(car);
    if (kind && car.traffic) crewed[kind].push(car);
  }
  // A unit whose crew got out is still out there, on foot: it counts until they've gone.
  const onFoot = { cop: 0, swat: 0, soldier: 0 };
  for (const ped of world.peds.values()) {
    if ((ped.kind === 'cop' || ped.kind === 'swat' || ped.kind === 'soldier') && ped.ai?.temporary && !isDead(ped)) onFoot[ped.kind]++;
  }
  const deployed = (kind: UnitKind) => {
    const { crew, crewSize } = UNITS[kind];
    return crewed[kind].length + (crewSize > 0 ? Math.ceil(onFoot[crew] / crewSize) : 0);
  };
  for (const kind of DISPATCH_ORDER) {
    if (crewed[kind].length > needed[kind]) {
      const idle = crewed[kind].find((c) => c.traffic!.pursuing === null && outOfSight(world, c.x, c.y));
      if (idle) world.cars.delete(idle.id);
    }
  }
  if (world.tick % DISPATCH_EVERY_TICKS !== 0) return;
  for (const kind of DISPATCH_ORDER) {
    if (deployed(kind) >= needed[kind]) continue;
    const suspect = mostWanted(world, UNITS[kind].minLevel);
    // (Patrol police cars are kept up by the traffic, see maintainTraffic.)
    if (!suspect) continue;
    const cell = hiddenLaneNear(world, suspect.x, suspect.y, DISPATCH_MIN_DISTANCE, DISPATCH_MAX_DISTANCE);
    if (!cell) return;
    const car = spawnCar(world, UNITS[kind].model, cell.x, cell.y, DIRECTIONS[cell.dir]!.heading);
    Object.assign(car, { police: true, color: UNITS[kind].color, turret: car.heading });
    startTraffic(world, car);
    return;
  }
}

/** The wanted player with the most stars (at least `minLevel`), if any. */
function mostWanted(world: World, minLevel: number): Ped | undefined {
  let best: Ped | undefined;
  for (const record of world.wanted) {
    const ped = world.peds.get(record.pedId);
    if (!ped || isDead(ped) || ped.wanted < minLevel) continue;
    if (!best || ped.wanted > best.wanted) best = ped;
  }
  return best;
}

/**
 * Roadblocks: from three stars, a suspect driving fast finds two police cars parked across their
 * road some way ahead (put there out of sight), lights flashing, with two cops behind them. They're
 * cleared away (out of sight) after a while, or once the suspect is no longer wanted that much.
 */
function maintainRoadblocks(world: World): void {
  world.roadblocks = world.roadblocks.filter((block) => {
    const suspect = world.peds.get(block.pedId);
    const over = world.tick >= block.until || !suspect || isDead(suspect) || suspect.wanted < ROADBLOCK_LEVEL;
    if (!over) return true;
    const cars = block.carIds.map((id) => world.cars.get(id)).filter((c): c is Car => c !== undefined);
    if (!cars.every((c) => outOfSight(world, c.x, c.y))) return true; // wait until nobody sees them go
    for (const car of cars) if (car.driverId === null && !car.wrecked) world.cars.delete(car.id);
    return false;
  });
  if (world.tick % ROADBLOCK_EVERY_TICKS !== 0 || world.roadblocks.length >= ROADBLOCKS_PER_ROOM) return;
  for (const record of world.wanted) {
    const suspect = world.peds.get(record.pedId);
    if (!suspect || isDead(suspect) || suspect.wanted < ROADBLOCK_LEVEL || suspect.carId === null) continue;
    if (world.roadblocks.some((b) => b.pedId === suspect.id)) continue;
    const car = world.cars.get(suspect.carId);
    if (!car || carSpeed(car) < ROADBLOCK_MIN_SPEED) continue;
    if (placeRoadblock(world, suspect, car)) return;
  }
}

/**
 * Puts a roadblock on the road ahead of a suspect's car: following their direction (rounded to
 * the grid) to a straight stretch of road ROADBLOCK_MIN/MAX_AHEAD blocks on, out of everyone's
 * sight. Two police cars across the road end to end, cops behind them. False if there's no such spot.
 */
export function placeRoadblock(world: World, suspect: Ped, car: Car): boolean {
  const map = world.map;
  // Their direction along the grid, from how they're moving.
  const dir = Math.abs(car.vx) > Math.abs(car.vy) ? (car.vx > 0 ? 0 : 2) : car.vy > 0 ? 1 : 3;
  const d = DIRECTIONS[dir]!;
  const across = { x: -d.dy, y: d.dx };
  const cx = Math.floor(car.x);
  const cy = Math.floor(car.y);
  for (let n = 1; n <= ROADBLOCK_MAX_AHEAD; n++) {
    const x = cx + d.dx * n;
    const y = cy + d.dy * n;
    const kind = kindAt(map, x, y);
    if (kind === Block.Building || kind === Block.Water) return false; // the road ends before that
    if (n < ROADBLOCK_MIN_AHEAD || kind !== Block.Road || laneAt(map, x, y) & Lane.Intersection) continue;
    // The road's width here, across the direction of travel.
    let from = 0;
    let to = 0;
    while (from > -4 && kindAt(map, x + across.x * (from - 1), y + across.y * (from - 1)) === Block.Road) from--;
    while (to < 4 && kindAt(map, x + across.x * (to + 1), y + across.y * (to + 1)) === Block.Road) to++;
    if (to - from > 3) continue; // not a plain straight road (a crossing, say)
    const mid = (from + to) / 2;
    const centre = { x: x + 0.5 + across.x * mid, y: y + 0.5 + across.y * mid };
    if (!outOfSight(world, centre.x, centre.y)) continue;
    const heading = Math.atan2(across.y, across.x);
    const half = CAR_MODELS.sedan.length / 2 + 0.03;
    const spots = [-1, 1].map((side) => ({ x: centre.x + across.x * half * side, y: centre.y + across.y * half * side }));
    const clear = spots.every((s) => !carCollides(map, CAR_MODELS.sedan, s.x, s.y, heading) && [...world.cars.values()].every((c) => Math.hypot(c.x - s.x, c.y - s.y) > 2));
    if (!clear) continue;
    const carIds = spots.map((spot) => {
      const police = spawnCar(world, 'sedan', spot.x, spot.y, heading);
      Object.assign(police, { police: true, color: UNITS.police.color, siren: true });
      return police.id;
    });
    // Two cops behind the cars (on the far side from the suspect).
    for (const side of [-1, 1]) {
      const px = centre.x + d.dx * 1.4 + across.x * 0.8 * side;
      const py = centre.y + d.dy * 1.4 + across.y * 0.8 * side;
      if (kindAt(map, Math.floor(px), Math.floor(py)) === Block.Building) continue;
      const cop = spawnPedestrian(world, Math.floor(px), Math.floor(py), 'cop');
      cop.x = px;
      cop.y = py;
      cop.heading = Math.atan2(-d.dy, -d.dx);
      cop.ai!.temporary = true;
    }
    world.roadblocks.push({ pedId: suspect.id, carIds, until: world.tick + ROADBLOCK_TICKS });
    return true;
  }
  return false;
}

/**
 * Takes law enforcers on foot who were brought in for a chase (`temporary`: out of police cars and
 * SWAT vans, at roadblocks, soldiers) off the streets once they're not needed and out of sight:
 * SWAT and soldiers when nobody's wanted enough for them, cops when nobody's wanted near them. The
 * cops on patrol stay. Their emptied vehicles go too, once nobody's wanted near them. One a tick.
 */
function clearUp(world: World): void {
  for (const car of world.cars.values()) {
    if (!unitKind(car) || car.traffic || car.driverId !== null || car.wrecked || !outOfSight(world, car.x, car.y)) continue;
    if (world.roadblocks.some((b) => b.carIds.includes(car.id))) continue;
    if (nearestWanted(world, car.x, car.y, 30)) continue;
    world.cars.delete(car.id);
    break;
  }
  for (const ped of world.peds.values()) {
    if (!isLaw(ped) || !ped.ai?.temporary || isDead(ped) || !outOfSight(world, ped.x, ped.y)) continue;
    const needed = ped.kind === 'swat' ? mostWanted(world, 4) : ped.kind === 'soldier' ? mostWanted(world, 6) : nearestWanted(world, ped.x, ped.y, 25);
    if (needed) continue;
    world.peds.delete(ped.id);
    return;
  }
}

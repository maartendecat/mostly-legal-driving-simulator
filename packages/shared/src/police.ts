import { isDead, type DamageCause } from './damage';
import { NO_INPUT, type PlayerInput } from './input';
import { lineOfSight } from './map';
import { driveTowards, forwardSpeed } from './navigate';
import { ejectDriver } from './pedestrians';
import { secondsToTicks } from './time';
import { tankInput } from './army';
import { deployUnits } from './escalation';
import type { TrafficState } from './traffic';
import { carSpeed, isLaw, type Car, type Ped, type World } from './world';

/**
 * The police (see docs/POLICE.md for the full plan; this is its first step).
 *
 * Crimes earn a player **heat**, and heat sets their **wanted level** (stars). Minor crimes only
 * count when the police see them (a cop or a crewed police car within sight); major ones (anything
 * against the police) are always reported. Out of the police's sight, the level drops one star at a
 * time. Killing other players is not a crime: that's the game.
 *
 * The response grows with the level. One star: police nearby chase the suspect and try to arrest
 * them. Two: police cars from all over the city join in, plus reinforcements, and cops shoot back at
 * a suspect who shoots. Three: cops shoot on sight and police cars ram. Arresting takes a second of
 * contact, during which the suspect can break away. Busted: out of their car, weapons gone, back a
 * moment later somewhere else. Dying, or getting busted, wipes the slate clean.
 */

/**
 * Police per room: `on` (everything up to the army), `noarmy` (up to five stars), or `off` (no cops
 * or police cars at all, and nothing is a crime).
 */
export type PoliceMode = 'on' | 'noarmy' | 'off';
export const POLICE_MODES: readonly PoliceMode[] = ['on', 'noarmy', 'off'];

export type Crime =
  | 'shooting'
  | 'runOver'
  | 'carjacking'
  | 'wreckCar'
  | 'killPerson'
  | 'assaultPolice'
  | 'stealPoliceCar'
  | 'killCop'
  | 'killSwat'
  | 'destroyArmy'
  | 'wreckPoliceCar';

/**
 * Heat per crime. Minor crimes only count when the police see them. Some can happen many times a
 * second (a burst of bullets into a police car): those count at most once per `cooldownTicks`.
 * Shooting is per second of firing (see reportCrime's `scale`).
 */
export const CRIMES: Record<Crime, { heat: number; major: boolean; cooldownTicks: number }> = {
  shooting: { heat: 2, major: false, cooldownTicks: 0 },
  runOver: { heat: 5, major: false, cooldownTicks: secondsToTicks(0.5) },
  carjacking: { heat: 10, major: false, cooldownTicks: 0 },
  wreckCar: { heat: 10, major: false, cooldownTicks: 0 },
  killPerson: { heat: 15, major: false, cooldownTicks: 0 },
  /** Ramming a police car, hurting a cop or a police car. */
  assaultPolice: { heat: 10, major: true, cooldownTicks: secondsToTicks(1) },
  stealPoliceCar: { heat: 20, major: true, cooldownTicks: 0 },
  killCop: { heat: 40, major: true, cooldownTicks: 0 },
  /** Killing a SWAT officer or a soldier. */
  killSwat: { heat: 60, major: true, cooldownTicks: 0 },
  /** Destroying a tank or shooting down a helicopter. */
  destroyArmy: { heat: 100, major: true, cooldownTicks: 0 },
  wreckPoliceCar: { heat: 40, major: true, cooldownTicks: 0 },
};

/** The heat at which each wanted level starts (index = level; 6 is the army). */
export const WANTED_LEVEL_HEAT = [0, 10, 30, 60, 100, 150, 220] as const;
/** Without the army, heat stops just short of level 6. */
const MAX_HEAT = { on: 300, noarmy: WANTED_LEVEL_HEAT[6] - 1, off: 0 } as const;

/** A player with heat: how much, and how long the police haven't seen them. */
export interface WantedRecord {
  pedId: number;
  heat: number;
  unseenTicks: number;
  /** Until when they count as shooting at the police (cops at two stars then shoot back). */
  hostileUntil: number;
  /** When each crime last counted, for crimes with a cooldown. */
  lastCrimeTick: Partial<Record<Crime, number>>;
  /** Ticks in a row at four stars or more: a long chase calls in the army (ARMY_AFTER_TICKS). */
  highTicks: number;
}

/** Out of the police's sight for this long plus LEVEL_DROP_TICKS, the first star goes... */
export const COOL_OFF_TICKS = secondsToTicks(10);
/** ...and then one more every LEVEL_DROP_TICKS. */
export const LEVEL_DROP_TICKS = secondsToTicks(15);
/** Kept at four or five stars this long, the army comes anyway. */
export const ARMY_AFTER_TICKS = secondsToTicks(90);
/** Shooting where the police see it (or at them) makes a suspect hostile for this long. */
const HOSTILE_TICKS = secondsToTicks(10);
/** Cops and police cars see a wanted player from this far (in blocks), in plain sight. */
const POLICE_SIGHT = 12;
/** A chasing police car drives at up to this speed (blocks/s), slower in turns. */
const PURSUIT_SPEED = 10;
const PURSUIT_TURN_SPEED = 4;
/** Below three stars a police car close behind a moving suspect keeps pace rather than ramming. */
const FOLLOW_DISTANCE = 5;
/** Pulls up when the suspect is this close and (nearly) standing still, then the cops get out. */
const PULL_UP_DISTANCE = 4;
const SUSPECT_STOPPED_SPEED = 2;
const HEAVY_PULL_UP_DISTANCE = 6;
const HEAVY_SUSPECT_STOPPED_SPEED = 4;
/** A car going slower than this can be arrested out of. */
export const ARRESTABLE_CAR_SPEED = 1;
/** Cops still try to arrest up to this level; above it they only shoot. */
export const MAX_ARREST_LEVEL = 3;
/** Taken away for this long before they're back (as long as a respawn after dying). */
export const BUSTED_TICKS = secondsToTicks(3);

/** The wanted level for an amount of heat. */
export function wantedLevel(heat: number): number {
  let level = 0;
  while (level + 1 < WANTED_LEVEL_HEAT.length && heat >= WANTED_LEVEL_HEAT[level + 1]!) level++;
  return level;
}

/**
 * A crime by `offenderId`, if they're a player: minor crimes only count if the police can see
 * them. Adds heat (times `scale`), and announces a higher wanted level with a 'wanted' event.
 */
export function reportCrime(world: World, offenderId: number | null, crime: Crime, scale = 1): void {
  if (world.policeMode === 'off') return;
  const offender = offenderId === null ? undefined : world.peds.get(offenderId);
  if (!offender || offender.kind !== 'player' || isDead(offender)) return;
  const def = CRIMES[crime];
  if (!def.major && !seenByPolice(world, offender)) return;
  let record = world.wanted.find((w) => w.pedId === offender.id);
  const last = record?.lastCrimeTick[crime];
  if (last !== undefined && world.tick - last < def.cooldownTicks) return;
  if (!record) {
    record = { pedId: offender.id, heat: 0, unseenTicks: 0, hostileUntil: 0, lastCrimeTick: {}, highTicks: 0 };
    world.wanted.push(record);
  }
  if (def.cooldownTicks > 0) record.lastCrimeTick[crime] = world.tick;
  record.heat = Math.min(record.heat + def.heat * scale, MAX_HEAT[world.policeMode]);
  record.unseenTicks = 0;
  if (crime === 'shooting' || def.major) record.hostileUntil = world.tick + HOSTILE_TICKS;
  const level = wantedLevel(record.heat);
  if (level > offender.wanted) {
    offender.wanted = level;
    world.events.push({ type: 'wanted', tick: world.tick, ownerId: offender.id, pedId: offender.id, level, x: offender.x, y: offender.y });
  }
}

/**
 * Someone got hurt by `attackerId`: the crime it is, if any. Hurting or killing other players
 * isn't one; hitting someone with a car or killing them is (when seen); anything against a cop is.
 */
export function reportHarm(world: World, victim: Ped, attackerId: number | null, cause: DamageCause, killed: boolean): void {
  if (victim.kind === 'player') return;
  if (victim.kind === 'cop') reportCrime(world, attackerId, killed ? 'killCop' : 'assaultPolice');
  else if (isLaw(victim)) reportCrime(world, attackerId, killed ? 'killSwat' : 'assaultPolice');
  else if (killed) reportCrime(world, attackerId, 'killPerson');
  else if (cause === 'runOver') reportCrime(world, attackerId, 'runOver');
}

/** A car was wrecked; whoever did it (`car.lastAttackerId`) committed a crime, if anyone saw. */
export function reportWreck(world: World, car: Car): void {
  if (car.lastAttackerId === null || car.lastAttackerId === car.driverId) return; // their own ride
  reportCrime(world, car.lastAttackerId, car.model === 'tank' ? 'destroyArmy' : car.police ? 'wreckPoliceCar' : 'wreckCar');
}

/** Who's in a police or army vehicle (and gets out of it): cops, SWAT or soldiers. */
export function crewOf(car: Car): 'cop' | 'swat' | 'soldier' {
  return car.model === 'swatVan' ? 'swat' : car.model === 'armyTruck' || car.model === 'tank' ? 'soldier' : 'cop';
}

/** A cop bribe: one star off at once. */
export function bribePolice(world: World, ped: Ped): void {
  const record = world.wanted.find((w) => w.pedId === ped.id);
  if (!record) return;
  const level = wantedLevel(record.heat);
  record.heat = level > 1 ? WANTED_LEVEL_HEAT[level - 1]! : 0;
  ped.wanted = wantedLevel(record.heat);
  if (record.heat === 0) world.wanted = world.wanted.filter((w) => w !== record);
}

/** Whether the police are after this ped (one star or more). */
export function isWanted(ped: Ped): boolean {
  return ped.wanted > 0;
}

/** Whether cops may shoot at this suspect: on sight from three stars; at two, if they've been shooting. */
export function policeMayShoot(world: World, suspect: Ped): boolean {
  if (suspect.wanted >= 3) return true;
  if (suspect.wanted < 2) return false;
  const record = world.wanted.find((w) => w.pedId === suspect.id);
  return record !== undefined && record.hostileUntil > world.tick;
}

/** A cop arrests a player: out of their car, weapons gone, back somewhere else in a moment. */
export function bust(world: World, suspect: Ped, cop: Ped): void {
  const car = suspect.carId === null ? undefined : world.cars.get(suspect.carId);
  if (car && car.driverId === suspect.id) car.driverId = null;
  Object.assign(suspect, { carId: null, weapon: null, ammo: {}, fireCooldown: 0, respawnAt: world.tick + BUSTED_TICKS, wanted: 0, beingArrested: 0 });
  world.wanted = world.wanted.filter((w) => w.pedId !== suspect.id);
  world.events.push({ type: 'busted', tick: world.tick, ownerId: cop.id, pedId: suspect.id, copId: cop.id, x: suspect.x, y: suspect.y });
}

/** Arrested and taken away (rather than dead): out of the game until they come back. */
export function isBusted(ped: Ped): boolean {
  return ped.respawnAt !== null && ped.health > 0;
}

/**
 * Can a cop standing next to them arrest them? On foot, or in a car that's (nearly) stopped, and
 * not above three stars (then the police shoot instead).
 */
export function canArrest(world: World, suspect: Ped): boolean {
  if (isDead(suspect) || suspect.wanted > MAX_ARREST_LEVEL) return false;
  const car = suspect.carId === null ? undefined : world.cars.get(suspect.carId);
  return !car || carSpeed(car) < ARRESTABLE_CAR_SPEED;
}

/**
 * Once per tick: the police keep (or lose) track of wanted players and their level drops while
 * unseen; police cars join or leave chases; reinforcements come and go.
 */
export function stepPolice(world: World): void {
  if (world.wanted.length > 0) {
    world.wanted = world.wanted.filter((record) => {
      const ped = world.peds.get(record.pedId);
      if (!ped) return false;
      if (isDead(ped)) {
        ped.wanted = 0;
        return false;
      }
      if (seenByPolice(world, ped)) record.unseenTicks = 0;
      else if (++record.unseenTicks > COOL_OFF_TICKS && (record.unseenTicks - COOL_OFF_TICKS) % LEVEL_DROP_TICKS === 0) {
        // One star down (after the cool-off, then every LEVEL_DROP_TICKS): to the start of the level below.
        const level = wantedLevel(record.heat);
        record.heat = level > 1 ? WANTED_LEVEL_HEAT[level - 1]! : 0;
      }
      // A long chase at four or five stars ends with the army being called in.
      record.highTicks = wantedLevel(record.heat) >= 4 ? record.highTicks + 1 : 0;
      if (record.highTicks >= ARMY_AFTER_TICKS && world.policeMode === 'on' && record.heat < WANTED_LEVEL_HEAT[6]) {
        record.heat = WANTED_LEVEL_HEAT[6];
        world.events.push({ type: 'wanted', tick: world.tick, ownerId: ped.id, pedId: ped.id, level: 6, x: ped.x, y: ped.y });
      }
      ped.wanted = wantedLevel(record.heat);
      return record.heat > 0;
    });
  }
  deployUnits(world);
}

/** The nearest wanted player (with at least `minLevel` stars) within `range`, if any. */
export function nearestWanted(world: World, x: number, y: number, range: number, minLevel = 1): Ped | undefined {
  let best: Ped | undefined;
  let bestDistance = range;
  for (const record of world.wanted) {
    const ped = world.peds.get(record.pedId);
    // (Some heat but not a star yet: nobody's after them.)
    if (!ped || isDead(ped) || ped.wanted < minLevel) continue;
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
    if (isLaw(other) && !isDead(other) && other.carId === null && sees(other.x, other.y)) return true;
  }
  for (const car of world.cars.values()) {
    if (car.police && car.traffic && sees(car.x, car.y)) return true;
  }
  return false;
}

/**
 * This tick's controls for a police car chasing `traffic.pursuing`: straight at them when it can
 * see them, otherwise along the roads; pulling up next to them once they've stopped, and sending
 * its cops out. Below three stars it keeps pace behind a moving suspect; from three it rams.
 */
export function pursuitInput(world: World, car: Car, traffic: TrafficState): PlayerInput {
  const suspect = traffic.pursuing === null ? undefined : world.peds.get(traffic.pursuing);
  if (!suspect) return NO_INPUT;
  if (car.model === 'tank') return tankInput(world, car, traffic, suspect);
  const forward = forwardSpeed(car);
  // A SWAT van or army truck stops further away, for a faster suspect, and lets out four.
  const heavy = car.model !== 'sedan';
  if (traffic.reverseTicks > 0) return driveTowards(world, car, traffic, suspect.x, suspect.y, PURSUIT_SPEED, PURSUIT_TURN_SPEED);

  const suspectCar = suspect.carId === null ? undefined : world.cars.get(suspect.carId);
  const suspectSpeed = suspectCar ? carSpeed(suspectCar) : 0;
  const distance = Math.hypot(suspect.x - car.x, suspect.y - car.y);
  if (distance < (heavy ? HEAVY_PULL_UP_DISTANCE : PULL_UP_DISTANCE) && suspectSpeed < (heavy ? HEAVY_SUSPECT_STOPPED_SPEED : SUSPECT_STOPPED_SPEED)) {
    if (Math.abs(forward) > 1) return { ...NO_INPUT, down: forward > 0, up: forward < 0 };
    // Stopped next to them: the crew gets out and goes for them; the car stays where it is.
    for (let i = 0; i < (heavy ? 4 : 2); i++) ejectDriver(world, car, suspect, crewOf(car), i % 2 === 0 ? 1 : -1);
    car.traffic = null;
    car.siren = false;
    return NO_INPUT;
  }

  const speed = suspect.wanted < 3 && distance < FOLLOW_DISTANCE ? Math.min(PURSUIT_SPEED, suspectSpeed + 1) : PURSUIT_SPEED;
  return driveTowards(world, car, traffic, suspect.x, suspect.y, speed, Math.min(PURSUIT_TURN_SPEED, speed));
}

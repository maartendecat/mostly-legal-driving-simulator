import { collectPickups, spawnBribe, spawnPickup, stepProjectiles, updateWeapons, type GameEvent, type Pickup, type Projectile } from './combat';
import { PED_MAX_HEALTH, damageCar, damagePed, isDead, updateLifecycle } from './damage';
import { NO_INPUT, type PlayerInput } from './input';
import { ejectDriver, maintainPedestrians, stepPedestrians, type PedestrianState } from './pedestrians';
import { maintainTraffic, trafficInput, type TrafficState } from './traffic';
import { isSolidAt, type BlockMap } from './map';
import { clamp, nextRandom, randomPick, wrapAngle } from './math';
import { TICK_DT, secondsToTicks } from './time';
import { CAR_MODELS, type CarModel, type CarModelId } from './vehicles';
import type { Grudge } from './gangs';
import type { Roadblock } from './escalation';
import { stepFire } from './fire';
import { buildCarGrid, carsNear, clearCarGrid } from './grid';
import { stepSprayShops } from './sprayshop';
import { stepHelicopters, type Helicopter } from './helicopter';
import { crewOf, reportCrime, stepPolice, type PoliceMode, type WantedRecord } from './police';
import type { WeaponId } from './weapons';

/**
 * The game simulation. It is plain data plus pure-ish step functions with no rendering or
 * networking, so the exact same code runs on the server (authoritative) and in the browser
 * (prediction). Headings are in radians, 0 = east, counter-clockwise positive.
 */

export const PED_RADIUS = 0.18;
const PED_WALK_SPEED = 3;
const PED_BACK_SPEED = 1.8;
const PED_TURN_RATE = 4.5;
/** How far from a car's edge a ped can still get in. */
const ENTER_REACH = 0.7;
const MAX_EXIT_SPEED = 4;
const COAST_DECEL = 3;
const HANDBRAKE_DECEL = 6;
const HANDBRAKE_TURN_BOOST = 1.35;
/** Speed below which steering is weakened, so parked cars can't spin on the spot. */
const FULL_STEER_SPEED = 2.5;
const WALL_BOUNCE = 0.25;
const CAR_RESTITUTION = 0.3;
/** Impacts slower than this (blocks/s) don't hurt; above it, damage grows with speed. */
const CRASH_SAFE_SPEED = 5;
const WALL_CRASH_DAMAGE = 6;
const CAR_CRASH_DAMAGE = 5;
/** Cops thrown out of their car by a car thief take this long to get back on their feet. */
const HIJACKED_COP_STUN_TICKS = secondsToTicks(1);
/** Damage per tick to a car a tank is pushing against (about 90 per second). */
const TANK_CRUSH_DAMAGE = 1.5;
/** The longest vehicle (the fire truck). */
const MAX_CAR_LENGTH = Math.max(...Object.values(CAR_MODELS).map((m) => m.length));
/** A ped further than this from a car's middle (along x or y) can't be touching it (the longest is 1.8). */
const PUSH_REACH = 1.2;
/** Hitting a police car faster than this (blocks/s) gets the police after you. */
const POLICE_BUMP_SPEED = 1;
/** A car hitting a ped faster than this hurts them; at about 6 blocks/s it's fatal. */
const RUN_OVER_SAFE_SPEED = 3;
const RUN_OVER_DAMAGE = 30;

export const CAR_COLORS = [0xc0392b, 0x2980b9, 0xf1c40f, 0x27ae60, 0xecf0f1, 0x8e44ad, 0xe67e22, 0x2c3e50];
const PED_COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12, 0x9b59b6, 0x1abc9c, 0xff66cc, 0xffffff];
/** Players' looks, by join order (gangsters and cops look like their gang or the police). */
const PLAYER_LOOKS: PedLook[] = ['man', 'woman', 'youth', 'worker'];
/** Weighted: common cars appear more often. */
const SPAWN_MODELS: CarModelId[] = ['compact', 'compact', 'sedan', 'sedan', 'sedan', 'sports', 'truck'];

/**
 * Who a ped is: a player, or one of the city's people (who walk on their own, see pedestrians.ts):
 * ordinary civilians, gang members on their gang's turf, cops on patrol, and SWAT officers and
 * soldiers who only turn up when a player's wanted level is high (see police.ts).
 */
export type PedKind = 'player' | 'civilian' | 'gangster' | 'cop' | 'swat' | 'soldier';

/** The police and the army: cops, SWAT officers and soldiers (see police.ts). */
export function isLaw(ped: Ped): boolean {
  return ped.kind === 'cop' || ped.kind === 'swat' || ped.kind === 'soldier';
}
/** What a player or civilian looks like. Elderly people walk slower, youths a little faster. */
export type PedLook = 'man' | 'woman' | 'youth' | 'worker' | 'elder';

export interface Ped {
  id: number;
  x: number;
  y: number;
  heading: number;
  carId: number | null;
  color: number;
  health: number;
  /** Set while dead: the tick at which the ped comes back. */
  respawnAt: number | null;
  /** The weapon in hand, or null when unarmed. */
  weapon: WeaponId | null;
  ammo: Partial<Record<WeaponId, number>>;
  /** Ticks until the next shot is allowed. */
  fireCooldown: number;
  /** Whether enter/exit was held last tick, so holding the key only toggles once. */
  enterHeld: boolean;
  /** Same for weapon switching. */
  switchHeld: boolean;
  kind: PedKind;
  /** A gang member's gang (a number from gangs.ts); 0 for everyone else. */
  gang: number;
  look: PedLook;
  /** A player's wanted level: 0, or 1–6 stars while the police are after them (see police.ts). */
  wanted: number;
  /** A player being arrested: how far a cop has got, from 0 (not at all) to 1 (busted). */
  beingArrested: number;
  /** A pedestrian's walking state; null for players. */
  ai: PedestrianState | null;
}

export interface Car {
  id: number;
  model: CarModelId;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  angVel: number;
  driverId: number | null;
  color: number;
  health: number;
  /** Set once the car is destroyed and burning: the tick at which it explodes. */
  explodeAt: number | null;
  /** A burnt-out shell: can't be driven or entered. */
  wrecked: boolean;
  /** For wrecks: the tick at which it's cleared away and replaced. */
  removeAt: number | null;
  /** Who last damaged the car, credited if it explodes. */
  lastAttackerId: number | null;
  /** Set while the car is city traffic, driving itself (see traffic.ts). */
  traffic: TrafficState | null;
  /** A police car (see police.ts). */
  police: boolean;
  /** Its lights flashing: chasing someone, or a fire truck on its way to a fire. */
  siren: boolean;
  /** A wreck still on fire: until this tick, unless the fire brigade puts it out (see fire.ts). */
  burnsUntil: number | null;
  /** A fire truck spraying water: where at. */
  spray: { x: number; y: number } | null;
  /** A tank's turret: where it points (an absolute heading; see army.ts). */
  turret: number;
  /** Ticks until a tank's cannon can fire again. */
  gunCooldown: number;
  /** How often it's been resprayed (see sprayshop.ts): asset packs that use their own paint switch to `color` then. */
  paintJobs: number;
}

export interface World {
  tick: number;
  map: BlockMap;
  peds: Map<number, Ped>;
  cars: Map<number, Car>;
  projectiles: Map<number, Projectile>;
  pickups: Map<number, Pickup>;
  /** Events from the most recent tick only; cleared at the start of every step. */
  events: GameEvent[];
  /** Tag mode: the player who is "it" (can't pick up weapons, their car burns fast). */
  itPedId: number | null;
  nextId: number;
  rngState: number;
  /** How many traffic cars to keep driving around (0: none). */
  trafficTarget: number;
  /** How many pedestrians (civilians) to keep walking around (0: none). */
  pedestrianTarget: number;
  /** How many members each gang keeps on its turf (0: no gangs). */
  gangTarget: number;
  /** How many cops to keep patrolling (0: none). */
  copTarget: number;
  /** How many police cars to keep driving around, besides the other traffic (0: none). */
  policeCarTarget: number;
  /** How many fire trucks can be out at once (0: no fire brigade). */
  fireTruckTarget: number;
  /** Whether there are police, and how far they go (see police.ts). */
  policeMode: PoliceMode;
  /** Players the police are after, until when (see police.ts). */
  wanted: WantedRecord[];
  /** The least heat every player has (co-op: the police pressure, rising; see Match). */
  heatFloor: number;
  /** Whether players can hurt each other (not in co-op). */
  friendlyFire: boolean;
  /** Roadblocks the police have set up (see escalation.ts). */
  roadblocks: Roadblock[];
  /** The army's helicopters (see helicopter.ts). */
  helicopters: Map<number, Helicopter>;
  /** Per spray shop: ticks a car has been waiting in its bay (see sprayshop.ts). */
  sprayProgress: number[];
  /** Gangs angry with players who hurt their members (see gangs.ts). */
  grudges: Grudge[];
}

export interface WorldOptions {
  /** Number of traffic cars to keep driving around the city. */
  traffic?: number;
  /** Number of pedestrians (civilians) to keep walking around the city. */
  pedestrians?: number;
  /** Number of members per gang, hanging around on their turf. */
  gangMembers?: number;
  /** Number of cops on patrol. */
  cops?: number;
  /** Number of police cars driving around (besides `traffic`). */
  policeCars?: number;
  /** Number of fire trucks that can be out at once. */
  fireTrucks?: number;
  /** Police on (the default), without the army, or off: then no cops or police cars at all. */
  police?: PoliceMode;
}

export function createWorld(map: BlockMap, seed = 1, { traffic = 0, pedestrians = 0, gangMembers = 0, cops = 0, policeCars = 0, fireTrucks = 0, police = 'on' }: WorldOptions = {}): World {
  const world: World = {
    tick: 0,
    map,
    peds: new Map(),
    cars: new Map(),
    projectiles: new Map(),
    pickups: new Map(),
    events: [],
    itPedId: null,
    nextId: 1,
    rngState: seed >>> 0,
    trafficTarget: traffic,
    pedestrianTarget: pedestrians,
    gangTarget: gangMembers,
    copTarget: police === 'off' ? 0 : cops,
    policeCarTarget: police === 'off' ? 0 : policeCars,
    policeMode: police,
    fireTruckTarget: fireTrucks,
    wanted: [],
    heatFloor: 0,
    friendlyFire: true,
    roadblocks: [],
    helicopters: new Map(),
    sprayProgress: map.sprayShops.map(() => 0),
    grudges: [],
  };
  for (const spawn of map.carSpawns) spawnRandomCar(world, spawn);
  for (const spawn of map.pickupSpawns) spawnPickup(world, spawn.weapon, spawn.x, spawn.y);
  if (police !== 'off') for (const spawn of map.bribeSpawns) spawnBribe(world, spawn.x, spawn.y);
  return world;
}

export function spawnCar(world: World, model: CarModelId, x: number, y: number, heading: number): Car {
  const car: Car = {
    id: world.nextId++,
    model,
    x,
    y,
    heading,
    vx: 0,
    vy: 0,
    angVel: 0,
    driverId: null,
    color: randomPick(world, CAR_COLORS),
    health: CAR_MODELS[model].health,
    explodeAt: null,
    wrecked: false,
    removeAt: null,
    lastAttackerId: null,
    traffic: null,
    police: false,
    siren: false,
    burnsUntil: null,
    spray: null,
    turret: heading,
    gunCooldown: 0,
    paintJobs: 0,
  };
  world.cars.set(car.id, car);
  return car;
}

/** Spawns a car of a random (weighted) model at a spawn point. */
export function spawnRandomCar(world: World, spawn: { x: number; y: number; heading: number }): Car {
  return spawnCar(world, randomPick(world, SPAWN_MODELS), spawn.x, spawn.y, spawn.heading);
}

/** Spawns a player's ped at the given position, or at a random pavement spawn point. */
export function spawnPed(world: World, x?: number, y?: number): Ped {
  const spawn =
    x !== undefined && y !== undefined
      ? { x, y }
      : world.map.pedSpawns.length > 0
        ? randomPick(world, world.map.pedSpawns)
        : { x: world.map.width / 2, y: world.map.height / 2 };
  const players = [...world.peds.values()].filter((p) => p.kind === 'player').length;
  const ped: Ped = {
    id: world.nextId++,
    x: spawn.x,
    y: spawn.y,
    heading: nextRandom(world) * Math.PI * 2 - Math.PI,
    carId: null,
    color: PED_COLORS[players % PED_COLORS.length]!,
    health: PED_MAX_HEALTH,
    respawnAt: null,
    weapon: null,
    ammo: {},
    fireCooldown: 0,
    enterHeld: false,
    switchHeld: false,
    kind: 'player',
    gang: 0,
    look: PLAYER_LOOKS[players % PLAYER_LOOKS.length]!,
    wanted: 0,
    beingArrested: 0,
    ai: null,
  };
  world.peds.set(ped.id, ped);
  return ped;
}

/** Copies the world's entities so it can be simulated forward without touching the original. The map is shared. */
export function cloneWorld(world: World): World {
  return {
    ...world,
    peds: new Map([...world.peds].map(([id, ped]) => [id, { ...ped, ammo: { ...ped.ammo }, ai: ped.ai && { ...ped.ai, target: { ...ped.ai.target }, panicFrom: ped.ai.panicFrom && { ...ped.ai.panicFrom }, panicPath: ped.ai.panicPath && { ...ped.ai.panicPath }, lookAt: ped.ai.lookAt && { ...ped.ai.lookAt }, seenBodies: [...ped.ai.seenBodies] } }])),
    cars: new Map([...world.cars].map(([id, car]) => [id, { ...car, spray: car.spray && { ...car.spray }, traffic: car.traffic && { ...car.traffic, route: car.traffic.route.map((p) => ({ ...p })), goingHome: car.traffic.goingHome && { ...car.traffic.goingHome } } }])),
    projectiles: new Map([...world.projectiles].map(([id, p]) => [id, { ...p }])),
    pickups: new Map([...world.pickups].map(([id, p]) => [id, { ...p }])),
    events: [],
    grudges: world.grudges.map((g) => ({ ...g })),
    wanted: world.wanted.map((w) => ({ ...w, lastCrimeTick: { ...w.lastCrimeTick } })),
    roadblocks: world.roadblocks.map((b) => ({ ...b, carIds: [...b.carIds] })),
    helicopters: new Map([...world.helicopters].map(([id, h]) => [id, { ...h }])),
    sprayProgress: [...world.sprayProgress],
  };
}

/** Removes a ped (e.g. a player who disconnected), leaving any car they were driving empty. */
export function removePed(world: World, pedId: number): void {
  const ped = world.peds.get(pedId);
  if (!ped) return;
  const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
  if (car && car.driverId === pedId) car.driverId = null;
  world.peds.delete(pedId);
}

export function carSpeed(car: Car): number {
  return Math.hypot(car.vx, car.vy);
}

/** Advances the world by one tick. `inputs` maps ped ids to that player's input for this tick. */
export function stepWorld(world: World, inputs: ReadonlyMap<number, PlayerInput>, dt = TICK_DT): void {
  world.events = [];
  for (const ped of world.peds.values()) {
    const input = inputs.get(ped.id) ?? NO_INPUT;
    const enterPressed = input.enter && !ped.enterHeld;
    ped.enterHeld = input.enter;
    const switchHeld = (input.weaponNext ? 1 : 0) - (input.weaponPrev ? 1 : 0);
    const switchDirection = ped.switchHeld ? 0 : switchHeld;
    ped.switchHeld = switchHeld !== 0;
    if (isDead(ped)) continue;

    if (ped.carId === null) {
      if (enterPressed && tryEnterCar(world, ped)) continue;
      walkPed(world.map, ped, input, dt);
    } else if (enterPressed) {
      tryExitCar(world, ped);
    }
    updateWeapons(world, ped, input, switchDirection);
  }

  buildCarGrid(world); // (where the cars are, for traffic looking ahead)
  for (const car of world.cars.values()) {
    const input = car.wrecked
      ? NO_INPUT
      : car.driverId !== null
        ? (inputs.get(car.driverId) ?? NO_INPUT)
        : car.traffic
          ? trafficInput(world, car)
          : NO_INPUT;
    driveCar(world, car, input, dt);
    if (car.gunCooldown > 0) car.gunCooldown--;
    // A player driving a tank aims the turret straight ahead.
    if (car.model === 'tank' && car.driverId !== null) car.turret = car.heading;
  }

  resolveCarCollisions(world);
  buildCarGrid(world); // (where the cars ended up, for the rest of the tick)

  for (const ped of world.peds.values()) {
    const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
    if (car) {
      ped.x = car.x;
      ped.y = car.y;
      ped.heading = car.heading;
    } else if (!isDead(ped)) {
      for (const other of carsNear(world, ped.x, ped.y, PUSH_REACH)) pushPedOutOfCar(world, ped, other);
    }
  }

  collectPickups(world);
  stepProjectiles(world, dt);
  stepPedestrians(world, dt);
  stepPolice(world);
  stepHelicopters(world, dt);
  stepFire(world);
  stepSprayShops(world);
  updateLifecycle(world);
  maintainTraffic(world);
  maintainPedestrians(world);
  clearCarGrid(world); // (outside a step, lookups see every car as it is)

  world.tick++;
}

// --- Peds ---------------------------------------------------------------------------------------

function walkPed(map: BlockMap, ped: Ped, input: PlayerInput, dt: number): void {
  // GTA2-style "tank" controls: left/right rotate, up/down walk along the facing direction.
  const turn = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  ped.heading = wrapAngle(ped.heading + turn * PED_TURN_RATE * dt);
  const speed = input.up ? PED_WALK_SPEED : input.down ? -PED_BACK_SPEED : 0;
  if (speed === 0) return;
  const dx = Math.cos(ped.heading) * speed * dt;
  const dy = Math.sin(ped.heading) * speed * dt;
  if (!pedCollides(map, ped.x + dx, ped.y)) ped.x += dx;
  if (!pedCollides(map, ped.x, ped.y + dy)) ped.y += dy;
}

export function pedCollides(map: BlockMap, x: number, y: number): boolean {
  const r = PED_RADIUS;
  return isSolidAt(map, x - r, y - r) || isSolidAt(map, x + r, y - r) || isSolidAt(map, x - r, y + r) || isSolidAt(map, x + r, y + r);
}

function tryEnterCar(world: World, ped: Ped): boolean {
  let best: Car | undefined;
  let bestDistance = Infinity;
  for (const car of world.cars.values()) {
    if (car.driverId !== null || car.wrecked) continue;
    const distance = Math.hypot(car.x - ped.x, car.y - ped.y);
    if (distance < CAR_MODELS[car.model].length / 2 + ENTER_REACH && distance < bestDistance) {
      best = car;
      bestDistance = distance;
    }
  }
  if (!best) return false;
  // Taking a traffic car: its driver is pulled out and runs off. (Only the server knows a car is
  // traffic, so only it adds the driver; clients see them in the next snapshot.)
  if (best.traffic && best.police) {
    // A police car, crew and all: they jump out, and now they're after you.
    for (const side of [1, -1] as const) {
      const cop = ejectDriver(world, best, ped, crewOf(best), side);
      if (cop) cop.ai!.waitTicks = HIJACKED_COP_STUN_TICKS; // a moment to get away
    }
    reportCrime(world, ped.id, 'stealPoliceCar');
  } else if (best.traffic) {
    ejectDriver(world, best, ped);
    reportCrime(world, ped.id, 'carjacking');
  }
  best.traffic = null;
  best.siren = false;
  best.spray = null;
  best.driverId = ped.id;
  ped.carId = best.id;
  return true;
}

function tryExitCar(world: World, ped: Ped): void {
  const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
  if (!car) {
    ped.carId = null;
    return;
  }
  if (carSpeed(car) > MAX_EXIT_SPEED) return;
  const exit = carExitPoint(world.map, car);
  if (!exit) return;
  ped.x = exit.x;
  ped.y = exit.y;
  ped.heading = car.heading;
  ped.carId = null;
  car.driverId = null;
}

/**
 * Where someone steps out: the driver's side (left, `side` 1), or the passenger's (right, -1), or
 * the other side if that one's blocked.
 */
export function carExitPoint(map: BlockMap, car: Car, side: 1 | -1 = 1): { x: number; y: number } | null {
  const offset = CAR_MODELS[car.model].width / 2 + PED_RADIUS + 0.05;
  for (const s of [side, -side]) {
    const x = car.x - Math.sin(car.heading) * offset * s;
    const y = car.y + Math.cos(car.heading) * offset * s;
    if (!pedCollides(map, x, y)) return { x, y };
  }
  return null;
}

/** Keeps peds out of cars, and hurts them if the car hits them fast enough (running them over). */
function pushPedOutOfCar(world: World, ped: Ped, car: Car): void {
  // (Far apart: nothing to do. Cheap, and most pairs are.)
  if (Math.abs(ped.x - car.x) > PUSH_REACH || Math.abs(ped.y - car.y) > PUSH_REACH) return;
  const m = CAR_MODELS[car.model];
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  const dx = ped.x - car.x;
  const dy = ped.y - car.y;
  // Ped position in the car's local frame (x forward, y left).
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const hl = m.length / 2;
  const hw = m.width / 2;
  const ex = lx - clamp(lx, -hl, hl);
  const ey = ly - clamp(ly, -hw, hw);
  const d2 = ex * ex + ey * ey;
  const r = PED_RADIUS;
  if (d2 >= r * r) return;

  let px: number;
  let py: number;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    px = (ex / d) * (r - d);
    py = (ey / d) * (r - d);
  } else {
    // Ped centre is inside the car: push out along the shallowest axis.
    const depthX = hl - Math.abs(lx) + r;
    const depthY = hw - Math.abs(ly) + r;
    if (depthX < depthY) {
      px = Math.sign(lx || 1) * depthX;
      py = 0;
    } else {
      px = 0;
      py = Math.sign(ly || 1) * depthY;
    }
  }
  const wx = px * cos - py * sin;
  const wy = px * sin + py * cos;

  // How fast the car is moving into the ped, along the direction the ped gets pushed.
  const length = Math.hypot(wx, wy);
  const impactSpeed = length > 1e-9 ? (car.vx * wx + car.vy * wy) / length : 0;
  if (impactSpeed > RUN_OVER_SAFE_SPEED) {
    damagePed(world, ped, (impactSpeed - RUN_OVER_SAFE_SPEED) * RUN_OVER_DAMAGE, car.driverId, 'runOver');
    if (isDead(ped)) return; // run over: the body stays where it fell
  }
  if (!pedCollides(world.map, ped.x + wx, ped.y + wy)) {
    ped.x += wx;
    ped.y += wy;
  }
}

// --- Cars ---------------------------------------------------------------------------------------

function driveCar(world: World, car: Car, input: PlayerInput, dt: number): void {
  const { map } = world;
  const m = CAR_MODELS[car.model];
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  // Split velocity into forward and sideways (right) components.
  let forward = car.vx * cos + car.vy * sin;
  let side = car.vx * sin - car.vy * cos;

  if (input.up) {
    forward = forward < 0 ? Math.min(forward + m.brake * dt, 0) : Math.min(forward + m.accel * dt * (1 - (0.5 * forward) / m.maxSpeed), m.maxSpeed);
  } else if (input.down) {
    forward = forward > 0 ? Math.max(forward - m.brake * dt, 0) : Math.max(forward - m.accel * 0.6 * dt, -m.reverseSpeed);
  } else {
    forward -= Math.sign(forward) * Math.min(Math.abs(forward), COAST_DECEL * dt);
  }
  if (input.handbrake) forward -= Math.sign(forward) * Math.min(Math.abs(forward), HANDBRAKE_DECEL * dt);

  // Arcade drift: sideways velocity bleeds off by grip, much more slowly with the handbrake on.
  side *= Math.exp(-(input.handbrake ? m.handbrakeGrip : m.grip) * dt);

  const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  // Steering scales with speed and flips when reversing.
  car.angVel = steer * m.turnRate * clamp(forward / FULL_STEER_SPEED, -1, 1) * (input.handbrake ? HANDBRAKE_TURN_BOOST : 1);

  car.vx = cos * forward + sin * side;
  car.vy = sin * forward - cos * side;

  const nx = car.x + car.vx * dt;
  if (carCollides(map, m, nx, car.y, car.heading)) {
    crash(world, car, Math.abs(car.vx));
    car.vx *= -WALL_BOUNCE;
  } else car.x = nx;
  const ny = car.y + car.vy * dt;
  if (carCollides(map, m, car.x, ny, car.heading)) {
    crash(world, car, Math.abs(car.vy));
    car.vy *= -WALL_BOUNCE;
  } else car.y = ny;
  const nh = car.heading + car.angVel * dt;
  if (carCollides(map, m, car.x, car.y, nh)) car.angVel = 0;
  else car.heading = wrapAngle(nh);
}

function crash(world: World, car: Car, impactSpeed: number): void {
  if (impactSpeed > CRASH_SAFE_SPEED) damageCar(world, car, (impactSpeed - CRASH_SAFE_SPEED) * WALL_CRASH_DAMAGE, null);
}

/** Whether a point lies inside the car's rectangle. */
export function carContainsPoint(car: Car, x: number, y: number): boolean {
  const m = CAR_MODELS[car.model];
  const dx = x - car.x;
  const dy = y - car.y;
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  return Math.abs(dx * cos + dy * sin) <= m.length / 2 && Math.abs(-dx * sin + dy * cos) <= m.width / 2;
}

/** Points on the car's outline (in half-length/half-width units) that are tested against walls. */
const CAR_SAMPLE_POINTS: readonly (readonly [number, number])[] = [
  [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0],
];

export function carCollides(map: BlockMap, model: CarModel, x: number, y: number, heading: number): boolean {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const hl = model.length / 2;
  const hw = model.width / 2;
  for (const [fx, fy] of CAR_SAMPLE_POINTS) {
    const lx = fx * hl;
    const ly = fy * hw;
    if (isSolidAt(map, x + cos * lx - sin * ly, y + sin * lx + cos * ly)) return true;
  }
  return false;
}

function resolveCarCollisions(world: World): void {
  // Sorted along x, each car only needs checking against the next few: two cars further apart than
  // the longest vehicle can't touch.
  const cars = [...world.cars.values()].sort((a, b) => a.x - b.x || a.id - b.id);
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length && cars[j]!.x - cars[i]!.x <= MAX_CAR_LENGTH; j++) collideCars(world, cars[i]!, cars[j]!);
  }
}

/** Approximates each car as two circles (front and back) and resolves the deepest overlap. */
function collideCars(world: World, a: Car, b: Car): void {
  const { map } = world;
  const ma = CAR_MODELS[a.model];
  const mb = CAR_MODELS[b.model];
  const reach = (ma.length + mb.length) / 2;
  if (Math.abs(a.x - b.x) > reach || Math.abs(a.y - b.y) > reach) return;

  const ra = ma.width / 2;
  const rb = mb.width / 2;
  let deepest = 0;
  let nx = 0;
  let ny = 0;
  for (const ca of carCircles(a, ma)) {
    for (const cb of carCircles(b, mb)) {
      const dx = ca[0] - cb[0];
      const dy = ca[1] - cb[1];
      const d = Math.hypot(dx, dy);
      const overlap = ra + rb - d;
      if (overlap > deepest && d > 1e-6) {
        deepest = overlap;
        nx = dx / d;
        ny = dy / d;
      }
    }
  }
  if (deepest <= 0) return;

  // Heavier cars move less: each is pushed out by the other's share of the total mass.
  const total = ma.mass + mb.mass;
  const pushA = (deepest * mb.mass) / total;
  const pushB = (deepest * ma.mass) / total;
  if (!carCollides(map, ma, a.x + nx * pushA, a.y + ny * pushA, a.heading)) {
    a.x += nx * pushA;
    a.y += ny * pushA;
  }
  if (!carCollides(map, mb, b.x - nx * pushB, b.y - ny * pushB, b.heading)) {
    b.x -= nx * pushB;
    b.y -= ny * pushB;
  }
  // A tank crushes whatever car it's pushing against, however slowly.
  if (a.model === 'tank' && !b.wrecked) damageCar(world, b, TANK_CRUSH_DAMAGE, a.driverId ?? a.lastAttackerId);
  if (b.model === 'tank' && !a.wrecked) damageCar(world, a, TANK_CRUSH_DAMAGE, b.driverId ?? b.lastAttackerId);

  const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  // Ramming a police car (more than a touch) is a crime: the police are after you at once.
  if (-approach > POLICE_BUMP_SPEED) {
    if (a.police && !a.wrecked) reportCrime(world, b.driverId, 'assaultPolice');
    if (b.police && !b.wrecked) reportCrime(world, a.driverId, 'assaultPolice');
  }
  if (-approach > CRASH_SAFE_SPEED) {
    // Both cars get hurt, the lighter one more; each driver gets the credit for what they did to the other car.
    const damage = (-approach - CRASH_SAFE_SPEED) * CAR_CRASH_DAMAGE;
    damageCar(world, a, (damage * 2 * mb.mass) / total, b.driverId);
    damageCar(world, b, (damage * 2 * ma.mass) / total, a.driverId);
  }
  if (approach < 0) {
    // An impulse along the contact normal, shared out by mass (equal masses: half each).
    const impulse = (-(1 + CAR_RESTITUTION) * approach) / (1 / ma.mass + 1 / mb.mass);
    a.vx += (nx * impulse) / ma.mass;
    a.vy += (ny * impulse) / ma.mass;
    b.vx -= (nx * impulse) / mb.mass;
    b.vy -= (ny * impulse) / mb.mass;
  }
}

function carCircles(car: Car, model: CarModel): [number, number][] {
  const offset = model.length / 2 - model.width / 2;
  const cx = Math.cos(car.heading) * offset;
  const cy = Math.sin(car.heading) * offset;
  return [
    [car.x + cx, car.y + cy],
    [car.x - cx, car.y - cy],
  ];
}

import { collectPickups, spawnPickup, stepProjectiles, updateWeapons, type GameEvent, type Pickup, type Projectile } from './combat';
import { NO_INPUT, type PlayerInput } from './input';
import { isSolidAt, type BlockMap } from './map';
import { clamp, nextRandom, randomPick, wrapAngle } from './math';
import { TICK_DT } from './time';
import { CAR_MODELS, type CarModel, type CarModelId } from './vehicles';
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

const CAR_COLORS = [0xc0392b, 0x2980b9, 0xf1c40f, 0x27ae60, 0xecf0f1, 0x8e44ad, 0xe67e22, 0x2c3e50];
const PED_COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12, 0x9b59b6, 0x1abc9c, 0xff66cc, 0xffffff];
/** Weighted: common cars appear more often. */
const SPAWN_MODELS: CarModelId[] = ['compact', 'compact', 'sedan', 'sedan', 'sedan', 'sports', 'truck'];

export interface Ped {
  id: number;
  x: number;
  y: number;
  heading: number;
  carId: number | null;
  color: number;
  /** The weapon in hand, or null when unarmed. */
  weapon: WeaponId | null;
  ammo: Partial<Record<WeaponId, number>>;
  /** Ticks until the next shot is allowed. */
  fireCooldown: number;
  /** Whether enter/exit was held last tick, so holding the key only toggles once. */
  enterHeld: boolean;
  /** Same for weapon switching. */
  switchHeld: boolean;
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
  nextId: number;
  rngState: number;
}

export function createWorld(map: BlockMap, seed = 1): World {
  const world: World = {
    tick: 0,
    map,
    peds: new Map(),
    cars: new Map(),
    projectiles: new Map(),
    pickups: new Map(),
    events: [],
    nextId: 1,
    rngState: seed >>> 0,
  };
  for (const spawn of map.carSpawns) {
    spawnCar(world, randomPick(world, SPAWN_MODELS), spawn.x, spawn.y, spawn.heading);
  }
  for (const spawn of map.pickupSpawns) spawnPickup(world, spawn.weapon, spawn.x, spawn.y);
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
  };
  world.cars.set(car.id, car);
  return car;
}

/** Spawns a ped at the given position, or at a random pavement spawn point. */
export function spawnPed(world: World, x?: number, y?: number): Ped {
  const spawn =
    x !== undefined && y !== undefined
      ? { x, y }
      : world.map.pedSpawns.length > 0
        ? randomPick(world, world.map.pedSpawns)
        : { x: world.map.width / 2, y: world.map.height / 2 };
  const ped: Ped = {
    id: world.nextId++,
    x: spawn.x,
    y: spawn.y,
    heading: nextRandom(world) * Math.PI * 2 - Math.PI,
    carId: null,
    color: PED_COLORS[world.peds.size % PED_COLORS.length]!,
    weapon: null,
    ammo: {},
    fireCooldown: 0,
    enterHeld: false,
    switchHeld: false,
  };
  world.peds.set(ped.id, ped);
  return ped;
}

/** Copies the world's entities so it can be simulated forward without touching the original. The map is shared. */
export function cloneWorld(world: World): World {
  return {
    ...world,
    peds: new Map([...world.peds].map(([id, ped]) => [id, { ...ped, ammo: { ...ped.ammo } }])),
    cars: new Map([...world.cars].map(([id, car]) => [id, { ...car }])),
    projectiles: new Map([...world.projectiles].map(([id, p]) => [id, { ...p }])),
    pickups: new Map([...world.pickups].map(([id, p]) => [id, { ...p }])),
    events: [],
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

    if (ped.carId === null) {
      if (enterPressed && tryEnterCar(world, ped)) continue;
      walkPed(world.map, ped, input, dt);
    } else if (enterPressed) {
      tryExitCar(world, ped);
    }
    updateWeapons(world, ped, input, switchDirection);
  }

  for (const car of world.cars.values()) {
    const input = car.driverId === null ? NO_INPUT : (inputs.get(car.driverId) ?? NO_INPUT);
    driveCar(world.map, car, input, dt);
  }

  resolveCarCollisions(world);

  for (const ped of world.peds.values()) {
    const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
    if (car) {
      ped.x = car.x;
      ped.y = car.y;
      ped.heading = car.heading;
    } else {
      for (const other of world.cars.values()) pushPedOutOfCar(world.map, ped, other);
    }
  }

  collectPickups(world);
  stepProjectiles(world, dt);

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
    if (car.driverId !== null) continue;
    const distance = Math.hypot(car.x - ped.x, car.y - ped.y);
    if (distance < CAR_MODELS[car.model].length / 2 + ENTER_REACH && distance < bestDistance) {
      best = car;
      bestDistance = distance;
    }
  }
  if (!best) return false;
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
  const offset = CAR_MODELS[car.model].width / 2 + PED_RADIUS + 0.05;
  // Prefer the driver's side (left), fall back to the right if that's blocked.
  for (const side of [1, -1]) {
    const x = car.x - Math.sin(car.heading) * offset * side;
    const y = car.y + Math.cos(car.heading) * offset * side;
    if (!pedCollides(world.map, x, y)) {
      ped.x = x;
      ped.y = y;
      ped.heading = car.heading;
      ped.carId = null;
      car.driverId = null;
      return;
    }
  }
}

function pushPedOutOfCar(map: BlockMap, ped: Ped, car: Car): void {
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
  if (!pedCollides(map, ped.x + wx, ped.y + wy)) {
    ped.x += wx;
    ped.y += wy;
  }
}

// --- Cars ---------------------------------------------------------------------------------------

function driveCar(map: BlockMap, car: Car, input: PlayerInput, dt: number): void {
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
  if (carCollides(map, m, nx, car.y, car.heading)) car.vx *= -WALL_BOUNCE;
  else car.x = nx;
  const ny = car.y + car.vy * dt;
  if (carCollides(map, m, car.x, ny, car.heading)) car.vy *= -WALL_BOUNCE;
  else car.y = ny;
  const nh = car.heading + car.angVel * dt;
  if (carCollides(map, m, car.x, car.y, nh)) car.angVel = 0;
  else car.heading = wrapAngle(nh);
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
  const cars = [...world.cars.values()];
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) collideCars(world.map, cars[i]!, cars[j]!);
  }
}

/** Approximates each car as two circles (front and back) and resolves the deepest overlap. */
function collideCars(map: BlockMap, a: Car, b: Car): void {
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

  const push = deepest / 2;
  if (!carCollides(map, ma, a.x + nx * push, a.y + ny * push, a.heading)) {
    a.x += nx * push;
    a.y += ny * push;
  }
  if (!carCollides(map, mb, b.x - nx * push, b.y - ny * push, b.heading)) {
    b.x -= nx * push;
    b.y -= ny * push;
  }

  const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (approach < 0) {
    const impulse = (-(1 + CAR_RESTITUTION) * approach) / 2;
    a.vx += nx * impulse;
    a.vy += ny * impulse;
    b.vx -= nx * impulse;
    b.vy -= ny * impulse;
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

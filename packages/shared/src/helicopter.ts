import { spawnProjectile } from './combat';
import { explode, isDead } from './damage';
import { nextRandom, wrapAngle } from './math';
import { reportCrime } from './police';
import { secondsToTicks } from './time';
import { outOfSight } from './traffic';
import type { Ped, World } from './world';

/**
 * The army's helicopter (six stars, see escalation.ts). It flies over everything, circles its
 * target at a short distance and fires machine-gun bursts down at them (those bullets fly over
 * walls). It can be shot down, with rockets or a lot of bullets: then it spins down and explodes
 * where it falls. When its target is no longer wanted that much, it flies off and disappears out
 * of sight.
 */
export interface Helicopter {
  id: number;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  health: number;
  /** Height above the ground, in blocks: cruising above the roofs, or lower while falling. */
  altitude: number;
  /** The player it's after; null when it's leaving. */
  targetId: number | null;
  /** Its angle around the target while circling. */
  orbit: number;
  /** Ticks until the next burst, and shots left in the current one. */
  gunCooldown: number;
  burstLeft: number;
  /** Shot down: the tick it hits the ground. */
  crashAt: number | null;
  /** Who last hit it, credited if it comes down. */
  lastAttackerId: number | null;
}

export const HELICOPTER_HEALTH = 300;
/** It's hit by projectiles passing within this distance of it (in blocks). */
export const HELICOPTER_RADIUS = 0.9;
/** Cruising height: above the tallest buildings. */
export const HELICOPTER_ALTITUDE = 7.5;
/** How many can be out at once, per room. */
const MAX_HELICOPTERS = 1;
/** It appears this far from its target (out of sight)... */
const SPAWN_DISTANCE = 32;
/** ...and circles it this far away, this fast (radians per second). */
const ORBIT_RADIUS = 5;
const ORBIT_SPEED = 0.35;
const MAX_SPEED = 9;
const ACCEL = 7;
const TURN_RATE = 2.5;
/** Fires from this close: bursts of this many shots, this many ticks apart, then a pause. */
const GUN_RANGE = 12;
const BURST_SHOTS = 6;
const BURST_GAP_TICKS = 6;
const BURST_PAUSE_TICKS = secondsToTicks(2.5);
const AIM_ERROR = 0.12;
/** Shot down, it falls for this long, then explodes like a car (but bigger). */
const CRASH_TICKS = secondsToTicks(2);
const CRASH_RADIUS = 3;
const CRASH_DAMAGE = 160;

/** Once per tick: helicopters fly, shoot, fall, leave; and one is sent when an army chase needs it. */
export function stepHelicopters(world: World, dt: number): void {
  for (const heli of [...world.helicopters.values()]) {
    if (heli.crashAt !== null) {
      fall(world, heli, dt);
      continue;
    }
    const target = heli.targetId === null ? undefined : world.peds.get(heli.targetId);
    if (!target || isDead(target) || target.wanted < 6) {
      heli.targetId = nextTarget(world)?.id ?? null;
      if (heli.targetId === null) {
        leave(world, heli, dt);
        continue;
      }
    }
    hunt(world, heli, world.peds.get(heli.targetId!)!, dt);
  }
  dispatchHelicopter(world);
}

/** Hurts a helicopter; at zero it's shot down (and whoever did it committed a crime). */
export function damageHelicopter(world: World, heli: Helicopter, amount: number, attackerId: number | null): void {
  if (heli.crashAt !== null || amount <= 0) return;
  if (attackerId !== null) heli.lastAttackerId = attackerId;
  heli.health = Math.max(0, heli.health - amount);
  if (heli.health > 0) return;
  heli.crashAt = world.tick + CRASH_TICKS;
  reportCrime(world, heli.lastAttackerId, 'destroyArmy');
}

/** The helicopter whose body is at (x, y), if any (projectiles from below hit it there). */
export function helicopterAt(world: World, x: number, y: number): Helicopter | undefined {
  for (const heli of world.helicopters.values()) {
    if (heli.crashAt === null && Math.hypot(heli.x - x, heli.y - y) < HELICOPTER_RADIUS) return heli;
  }
  return undefined;
}

function nextTarget(world: World): Ped | undefined {
  for (const record of world.wanted) {
    const ped = world.peds.get(record.pedId);
    if (ped && !isDead(ped) && ped.wanted >= 6) return ped;
  }
  return undefined;
}

/** Circles the target and fires bursts at them. */
function hunt(world: World, heli: Helicopter, target: Ped, dt: number): void {
  heli.orbit = wrapAngle(heli.orbit + ORBIT_SPEED * dt);
  flyTowards(heli, target.x + Math.cos(heli.orbit) * ORBIT_RADIUS, target.y + Math.sin(heli.orbit) * ORBIT_RADIUS, dt);
  const aim = Math.atan2(target.y - heli.y, target.x - heli.x);
  turnTowards(heli, aim, dt);
  if (heli.gunCooldown > 0) {
    heli.gunCooldown--;
    return;
  }
  if (Math.hypot(target.x - heli.x, target.y - heli.y) > GUN_RANGE) return;
  if (heli.burstLeft === 0) heli.burstLeft = BURST_SHOTS;
  spawnProjectile(world, 'machineGun', heli.id, heli.x, heli.y, aim + (nextRandom(world) * 2 - 1) * AIM_ERROR, true);
  heli.burstLeft--;
  heli.gunCooldown = heli.burstLeft > 0 ? BURST_GAP_TICKS : BURST_PAUSE_TICKS;
}

/** Nobody to hunt: away towards the nearest edge of the map, gone once out of sight. */
function leave(world: World, heli: Helicopter, dt: number): void {
  const { width, height } = world.map;
  const exits = [
    { x: -5, y: heli.y, d: heli.x },
    { x: width + 5, y: heli.y, d: width - heli.x },
    { x: heli.x, y: -5, d: heli.y },
    { x: heli.x, y: height + 5, d: height - heli.y },
  ];
  const exit = exits.reduce((a, b) => (b.d < a.d ? b : a));
  flyTowards(heli, exit.x, exit.y, dt);
  turnTowards(heli, Math.atan2(heli.vy, heli.vx), dt);
  if (outOfSight(world, heli.x, heli.y)) world.helicopters.delete(heli.id);
}

/** Shot down: spinning, losing height, then it hits the ground and explodes. */
function fall(world: World, heli: Helicopter, dt: number): void {
  heli.heading = wrapAngle(heli.heading + 6 * dt);
  heli.vx *= 0.98;
  heli.vy *= 0.98;
  heli.x += heli.vx * dt;
  heli.y += heli.vy * dt;
  heli.altitude = Math.max(0, heli.altitude - (HELICOPTER_ALTITUDE / CRASH_TICKS) * 60 * dt);
  if (world.tick < heli.crashAt!) return;
  world.helicopters.delete(heli.id);
  explode(world, heli.x, heli.y, CRASH_RADIUS, CRASH_DAMAGE, heli.lastAttackerId, 'carExplosion');
}

/** Accelerates towards a point, slowing down as it gets there. */
function flyTowards(heli: Helicopter, x: number, y: number, dt: number): void {
  const dx = x - heli.x;
  const dy = y - heli.y;
  const distance = Math.hypot(dx, dy);
  const speed = Math.min(MAX_SPEED, distance * 1.5);
  const wantVx = distance > 1e-6 ? (dx / distance) * speed : 0;
  const wantVy = distance > 1e-6 ? (dy / distance) * speed : 0;
  const ax = wantVx - heli.vx;
  const ay = wantVy - heli.vy;
  const a = Math.hypot(ax, ay);
  const max = ACCEL * dt;
  const scale = a > max ? max / a : 1;
  heli.vx += ax * scale;
  heli.vy += ay * scale;
  heli.x += heli.vx * dt;
  heli.y += heli.vy * dt;
}

function turnTowards(heli: Helicopter, heading: number, dt: number): void {
  const turn = wrapAngle(heading - heli.heading);
  const max = TURN_RATE * dt;
  heli.heading = wrapAngle(heli.heading + Math.max(-max, Math.min(max, turn)));
}

/** Sends a helicopter for a six-star player who hasn't got one, from out of sight. */
function dispatchHelicopter(world: World): void {
  if (world.policeMode !== 'on' || world.tick % 60 !== 0 || world.helicopters.size >= MAX_HELICOPTERS) return;
  const target = nextTarget(world);
  if (!target) return;
  // From a random direction, somewhere nobody can see it appear.
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = nextRandom(world) * Math.PI * 2;
    const x = target.x + Math.cos(angle) * SPAWN_DISTANCE;
    const y = target.y + Math.sin(angle) * SPAWN_DISTANCE;
    if (!outOfSight(world, x, y)) continue;
    spawnHelicopter(world, x, y, target.id);
    return;
  }
}

export function spawnHelicopter(world: World, x: number, y: number, targetId: number | null): Helicopter {
  const heli: Helicopter = {
    id: world.nextId++,
    x,
    y,
    heading: 0,
    vx: 0,
    vy: 0,
    health: HELICOPTER_HEALTH,
    altitude: HELICOPTER_ALTITUDE,
    targetId,
    orbit: 0,
    gunCooldown: secondsToTicks(1),
    burstLeft: 0,
    crashAt: null,
    lastAttackerId: null,
  };
  world.helicopters.set(heli.id, heli);
  return heli;
}

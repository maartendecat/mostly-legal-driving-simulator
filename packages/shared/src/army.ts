import { NO_INPUT, type PlayerInput } from './input';
import { lineOfSight } from './map';
import { wrapAngle } from './math';
import { driveTowards, forwardSpeed } from './navigate';
import { spawnProjectile } from './combat';
import { reportCrime } from './police';
import { TICK_DT, TICK_RATE } from './time';
import type { TrafficState } from './traffic';
import { CAR_MODELS } from './vehicles';
import { WEAPONS } from './weapons';
import type { Car, Ped, World } from './world';

/**
 * The army's tank (see escalation.ts for when it comes). It rolls slowly towards its target, its
 * turret turning on its own, and fires a shell whenever it has them lined up in plain sight. It
 * pushes anything aside and crushes cars it drives into (see the collisions in world.ts), and
 * bullets barely scratch it. A player can steal one: then the turret faces forward and fire
 * shoots the cannon.
 */

const TANK_SPEED = 5;
/** Close enough: stop and shell them rather than drive into the blast. */
const TANK_STOP_DISTANCE = 6;
/** Fires at targets this close, but not closer than this (it would be caught in its own blast). */
const TANK_RANGE = 15;
const TANK_MIN_RANGE = 2.6;
/** How quickly the turret turns (radians per second), and how well lined up it fires. */
const TURRET_TURN_RATE = 1.6;
const TURRET_AIMED = 0.06;

/** This tick's controls for an army tank going after `suspect`, and its turret and cannon. */
export function tankInput(world: World, tank: Car, traffic: TrafficState, suspect: Ped): PlayerInput {
  const distance = Math.hypot(suspect.x - tank.x, suspect.y - tank.y);
  const aim = Math.atan2(suspect.y - tank.y, suspect.x - tank.x);
  const turn = wrapAngle(aim - tank.turret);
  const maxTurn = TURRET_TURN_RATE * TICK_DT;
  tank.turret = wrapAngle(tank.turret + Math.max(-maxTurn, Math.min(maxTurn, turn)));
  if (Math.abs(turn) < TURRET_AIMED && distance <= TANK_RANGE && distance >= TANK_MIN_RANGE && lineOfSight(world.map, tank.x, tank.y, suspect.x, suspect.y)) {
    fireCannon(world, tank, null);
  }
  if (distance < TANK_STOP_DISTANCE && lineOfSight(world.map, tank.x, tank.y, suspect.x, suspect.y)) {
    const forward = forwardSpeed(tank);
    return { ...NO_INPUT, down: forward > 0.3, up: forward < -0.3 };
  }
  return driveTowards(world, tank, traffic, suspect.x, suspect.y, TANK_SPEED, TANK_SPEED);
}

/**
 * Fires a tank's cannon along its turret, if it's loaded. `gunnerId` is the player driving it, if
 * any (they get the credit, and it's a crime); otherwise the tank itself is the shooter.
 */
export function fireCannon(world: World, tank: Car, gunnerId: number | null): void {
  if (tank.gunCooldown > 0 || tank.wrecked) return;
  const weapon = WEAPONS.tankShell;
  const muzzle = CAR_MODELS[tank.model].length / 2 + 0.45;
  spawnProjectile(world, 'tankShell', gunnerId ?? tank.id, tank.x + Math.cos(tank.turret) * muzzle, tank.y + Math.sin(tank.turret) * muzzle, tank.turret);
  tank.gunCooldown = weapon.cooldownTicks;
  if (gunnerId !== null) reportCrime(world, gunnerId, 'shooting', weapon.cooldownTicks / TICK_RATE);
}

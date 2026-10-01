import type { BlockMap } from './map';
import { secondsToTicks } from './time';
import type { Ped, World } from './world';

/**
 * The city's gangs. Each owns a part of the city (its turf, see BlockMap.territory) where its
 * members hang around, armed. Hurt one of them and the whole gang holds a grudge against you for a
 * while: members who can see you shoot at you. (Names are our own; GTA2's belong to Rockstar.)
 *
 * A gang's number is its index here plus one; 0 means no gang (neutral ground).
 */
export const GANGS = [
  { name: 'The Suits', color: 0x4a4e69 },
  { name: 'The Lab Rats', color: 0x2ec4b6 },
  { name: 'The Undead', color: 0x7cb342 },
] as const;

export function gangName(gang: number): string {
  return GANGS[gang - 1]?.name ?? 'nobody';
}

/** How long a gang stays angry with someone who hurt one of its members. */
export const GRUDGE_TICKS = secondsToTicks(30);
/** Gang members shoot at someone they hold a grudge against from this close (in blocks)... */
export const GANG_SHOOT_RANGE = 10;
/** ...and come closer from up to this far. */
export const GANG_NOTICE_RANGE = 15;

/** A gang angry with a player, until a tick. */
export interface Grudge {
  gang: number;
  pedId: number;
  until: number;
}

/**
 * A gang member was hurt: if a player did it, the whole gang is after them (again) for a while.
 * A new grudge is announced with a 'gangAngry' event.
 */
export function provokeGang(world: World, member: Ped, attackerId: number | null): void {
  const attacker = attackerId === null ? undefined : world.peds.get(attackerId);
  if (!attacker || attacker.kind !== 'player' || member.gang === 0) return;
  const until = world.tick + GRUDGE_TICKS;
  const grudge = world.grudges.find((g) => g.gang === member.gang && g.pedId === attacker.id);
  if (grudge) {
    grudge.until = until;
    return;
  }
  world.grudges.push({ gang: member.gang, pedId: attacker.id, until });
  world.events.push({ type: 'gangAngry', tick: world.tick, ownerId: attacker.id, gang: member.gang, pedId: attacker.id, x: member.x, y: member.y });
}

/** Forgets grudges that ran out, and those against players who left. */
export function expireGrudges(world: World): void {
  if (world.grudges.length === 0) return;
  world.grudges = world.grudges.filter((g) => g.until > world.tick && world.peds.has(g.pedId));
}

/** Whose turf a point is on (a gang number), 0 for neutral ground. */
export function turfAt(map: BlockMap, x: number, y: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return 0;
  return map.territory[cy * map.width + cx]!;
}

import { gangName, type DamageCause, type GameEvent } from '@game/shared';
import type { GameSession } from '../session/GameSession';

export type DeathEvent = Extract<GameEvent, { type: 'death' }>;

const CAUSES: Record<DamageCause, string> = {
  pistol: 'pistol',
  machineGun: 'machine gun',
  rocketLauncher: 'rocket',
  runOver: 'run over',
  carExplosion: 'car explosion',
  tankShell: 'tank shell',
};

export function causeName(cause: DamageCause): string {
  return CAUSES[cause];
}

/** A player's name; for the city's people, their gang, the police or the army (anyone else is "Someone"). */
export function playerName(session: GameSession, pedId: number | null): string {
  const player = session.players.find((p) => p.pedId === pedId);
  if (player) return player.name;
  const ped = pedId === null ? undefined : session.world.peds.get(pedId);
  if (ped?.kind === 'gangster') return gangName(ped.gang);
  if (ped?.kind === 'cop') return 'A cop';
  if (ped?.kind === 'swat') return 'SWAT';
  if (ped?.kind === 'soldier') return 'A soldier';
  // The army's machines shoot with nobody at the controls: the tank or helicopter itself.
  if (pedId !== null && session.world.cars.get(pedId)?.model === 'tank') return 'A tank';
  if (pedId !== null && session.world.helicopters.has(pedId)) return 'A helicopter';
  return 'Someone';
}

/** What the WASTED screen says about your own death. */
export function describeOwnDeath(session: GameSession, death: DeathEvent): string {
  const killer = playerName(session, death.killerId);
  if (death.killerId === null) return death.cause === 'runOver' ? 'Hit by a runaway car' : 'Your ride went up in flames';
  if (death.killerId === death.pedId) return 'You blew yourself up';
  if (death.cause === 'runOver') return `${killer} ran you over`;
  if (death.cause === 'carExplosion') return `${killer} blew you up`;
  return `${killer} got you with the ${causeName(death.cause)}`;
}

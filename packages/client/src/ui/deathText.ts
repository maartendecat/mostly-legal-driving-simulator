import type { DamageCause, GameEvent } from '@game/shared';
import type { GameSession } from '../session/GameSession';

export type DeathEvent = Extract<GameEvent, { type: 'death' }>;

const CAUSES: Record<DamageCause, string> = {
  pistol: 'pistol',
  machineGun: 'machine gun',
  rocketLauncher: 'rocket',
  runOver: 'run over',
  carExplosion: 'car explosion',
};

export function causeName(cause: DamageCause): string {
  return CAUSES[cause];
}

export function playerName(session: GameSession, pedId: number | null): string {
  return session.players.find((p) => p.pedId === pedId)?.name ?? 'Someone';
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

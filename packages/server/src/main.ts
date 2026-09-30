import { DEFAULT_MATCH_SETTINGS, DEFAULT_SERVER_PORT, MATCH_MODES, TICK_RATE, secondsToTicks, type MatchMode } from '@game/shared';
import { GameServer } from './GameServer';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
const seed = Number(process.env.SEED ?? 1234);
// MODE: frag, points, tag, or rotate (all three in turn).
const mode = process.env.MODE ?? 'frag';
const modes: MatchMode[] = mode === 'rotate' ? [...MATCH_MODES] : [mode as MatchMode];
if (!modes.every((m) => MATCH_MODES.includes(m))) throw new Error(`MODE must be one of ${MATCH_MODES.join(', ')} or rotate, not "${mode}"`);
// SCORE_LIMIT: frags, points or seconds as "it" (0 = none); only for a single mode.
// TIME_LIMIT: match length in minutes (0 = none).
const scoreLimits = { ...DEFAULT_MATCH_SETTINGS.scoreLimits };
if (process.env.SCORE_LIMIT !== undefined && modes.length === 1) {
  const limit = Number(process.env.SCORE_LIMIT);
  scoreLimits[modes[0]!] = modes[0] === 'tag' ? secondsToTicks(limit) : limit;
}
const minutes = Number(process.env.TIME_LIMIT ?? DEFAULT_MATCH_SETTINGS.timeLimitTicks / TICK_RATE / 60);

const server = new GameServer({ port, seed, match: { modes, scoreLimits, timeLimitTicks: secondsToTicks(minutes * 60) } });
await server.listening();
console.log(`Game server listening on ws://localhost:${server.port} (city seed ${seed})`);
console.log(`Modes: ${modes.join(' → ')}, ${minutes > 0 ? `${minutes} min` : 'no time limit'} per match`);

setInterval(() => {
  if (server.playerCount > 0) console.log(`tick ${server.world.tick} · ${server.playerCount} player(s)`);
}, 10_000);

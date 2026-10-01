import { DEFAULT_MATCH_SETTINGS, DEFAULT_SERVER_PORT, MATCH_MODES, TICK_RATE, secondsToTicks, type MatchMode } from '@game/shared';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// STATIC_DIR: the built client to serve on the same port; defaults to packages/client/dist if built.
const builtClient = fileURLToPath(new URL('../../client/dist', import.meta.url));
const staticDir = process.env.STATIC_DIR ?? (existsSync(builtClient) ? builtClient : undefined);

// TRAFFIC / PEDESTRIANS / GANG_MEMBERS / COPS: cars driving and people walking around each room's
// city: civilians, members per gang (on their turf), and cops (0 for none).
const traffic = Number(process.env.TRAFFIC ?? 16);
const pedestrians = Number(process.env.PEDESTRIANS ?? 40);
const gangMembers = Number(process.env.GANG_MEMBERS ?? 6);
const cops = Number(process.env.COPS ?? 6);

const server = new GameServer({ port, seed, staticDir, traffic, pedestrians, gangMembers, cops, match: { modes, scoreLimits, timeLimitTicks: secondsToTicks(minutes * 60) } });
await server.listening();
console.log(`Game server listening on port ${server.port} (city seed ${seed})`);
console.log(staticDir ? `Serving the game at http://localhost:${server.port}` : 'Not serving the game page (run npm run build first, or use the Vite dev server)');
console.log(`Modes: ${modes.join(' → ')}, ${minutes > 0 ? `${minutes} min` : 'no time limit'} per match; ${traffic} traffic cars, ${pedestrians} pedestrians, ${gangMembers} members per gang and ${cops} cops per room`);

setInterval(() => {
  if (server.playerCount > 0) console.log(`tick ${server.world.tick} · ${server.playerCount} player(s)`);
}, 10_000);

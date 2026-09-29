import { CAR_MODELS, DEFAULT_SERVER_PORT, carSpeed } from '@game/shared';
import type { AssetPack } from './assets/AssetPack';
import { PlaceholderPack } from './assets/placeholder/PlaceholderPack';
import { Keyboard } from './input/Keyboard';
import { GameRenderer } from './render/GameRenderer';
import type { TransformSnapshot } from './render/transforms';
import type { GameSession } from './session/GameSession';
import { LocalSession } from './session/LocalSession';
import { NetworkSession } from './session/NetworkSession';
import { showJoinScreen } from './ui/JoinScreen';
import { NameTags, type NameTag } from './ui/NameTags';

/** Height above the ground at which name tags float, in blocks. */
const NAME_TAG_HEIGHT = 0.9;

/**
 * URL options:
 *   ?offline           play single-player without a server
 *   ?server=ws://...   game server to connect to (default: same host, port 8080)
 *   ?seed=42           city seed for offline play
 *   ?lag=150           simulate this much round-trip network delay, in ms (for testing)
 */
async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const session = await startSession(params);

  const pack: AssetPack = new PlaceholderPack();
  await pack.load();
  const renderer = new GameRenderer(document.getElementById('game')!, pack);
  renderer.setMap(session.world.map);
  const nameTags = new NameTags(document.getElementById('tags')!);
  const hud = document.getElementById('hud')!;

  // Handy for debugging from the browser console; stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { game: session });

  const keyboard = new Keyboard();
  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    // Clamp long frames (e.g. background tab) so we don't simulate a huge backlog at once.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const { transforms } = session.update(frameDt, () => keyboard.sample());
    renderer.render(session.world, transforms, session.myPedId, frameDt);
    nameTags.update(nameTagsFor(session, transforms, renderer));

    if (frameDt > 0) fps += (1 / frameDt - fps) * 0.05;
    hud.textContent = hudText(session, fps, pack);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function startSession(params: URLSearchParams): Promise<GameSession> {
  const seed = Number(params.get('seed')) || 1234;
  if (params.has('offline')) return Promise.resolve(new LocalSession(seed));

  const serverUrl = params.get('server') ?? `ws://${location.hostname}:${DEFAULT_SERVER_PORT}`;
  const lagMs = Number(params.get('lag')) || 0;
  return showJoinScreen({
    serverUrl,
    connect: (name) => NetworkSession.connect(serverUrl, { name, lagMs }),
    playOffline: () => new LocalSession(seed),
  });
}

/** A tag over every other player: over their ped on foot, or over the car they're driving. */
function nameTagsFor(session: GameSession, transforms: TransformSnapshot, renderer: GameRenderer): NameTag[] {
  const tags: NameTag[] = [];
  for (const player of session.players) {
    if (player.pedId === session.myPedId) continue;
    const ped = session.world.peds.get(player.pedId);
    if (!ped) continue;
    const position = transforms.get(ped.carId ?? ped.id) ?? ped;
    const screen = renderer.projectToScreen(position.x, position.y, NAME_TAG_HEIGHT);
    if (screen) tags.push({ id: player.pedId, text: player.name, ...screen });
  }
  return tags;
}

function hudText(session: GameSession, fps: number, pack: AssetPack): string {
  const world = session.world;
  const ped = session.myPedId === null ? undefined : world.peds.get(session.myPedId);
  const car = ped?.carId != null ? world.cars.get(ped.carId) : undefined;
  const status = car ? `Driving: ${CAR_MODELS[car.model].name}  ${Math.round(carSpeed(car) * 10)} km/h` : 'On foot';
  const me = session.players.find((p) => p.pedId === session.myPedId);
  const others = session.players.filter((p) => p !== me).map((p) => p.name);
  return [
    status,
    '',
    'Arrows/WASD  move / steer',
    'Enter or F   get in / out of car',
    'Space        handbrake',
    '',
    me && session instanceof NetworkSession ? `You are ${me.name}` : '',
    others.length > 0 ? `Also here: ${others.join(', ')}` : '',
    session.status,
    `${Math.round(fps)} fps · tick ${world.tick} · assets: ${pack.name}`,
  ]
    .filter((line, i, lines) => line !== '' || lines[i - 1] !== '')
    .join('\n');
}

main().catch((error: unknown) => {
  console.error(error);
  document.getElementById('hud')!.textContent = `Failed to start: ${String(error)}`;
});

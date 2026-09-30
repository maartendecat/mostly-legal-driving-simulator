import { CAR_MODELS, DEFAULT_SERVER_PORT, PED_MAX_HEALTH, TICK_RATE, WEAPONS, carSpeed, isDead, type GameEvent, type Ped, type PlayerInfo } from '@game/shared';
import type { AssetPack } from './assets/AssetPack';
import { PlaceholderPack } from './assets/placeholder/PlaceholderPack';
import { Keyboard } from './input/Keyboard';
import { GameRenderer } from './render/GameRenderer';
import type { Transform, TransformSnapshot } from './render/transforms';
import type { GameSession } from './session/GameSession';
import { LocalSession } from './session/LocalSession';
import { NetworkSession } from './session/NetworkSession';
import { describeOwnDeath } from './ui/deathText';
import { showJoinScreen } from './ui/JoinScreen';
import { KillFeed } from './ui/KillFeed';
import { NameTags, type NameTag } from './ui/NameTags';
import { PlayerArrows, type PlayerArrow } from './ui/PlayerArrows';
import { Scoreboard } from './ui/Scoreboard';

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
  const arrows = new PlayerArrows(document.getElementById('arrows')!);
  const hud = document.getElementById('hud')!;
  const wasted = new WastedScreen();
  const killFeed = new KillFeed(document.getElementById('killfeed')!);
  const scoreboard = new Scoreboard(document.getElementById('match-status')!, document.getElementById('scoreboard')!);
  // Hold Tab for the scoreboard (and keep Tab from moving focus around the page).
  const toggleScoreboard = (event: KeyboardEvent, held: boolean) => {
    if (event.code !== 'Tab') return;
    event.preventDefault();
    scoreboard.held = held;
  };
  window.addEventListener('keydown', (e) => toggleScoreboard(e, true));
  window.addEventListener('keyup', (e) => toggleScoreboard(e, false));
  window.addEventListener('blur', () => (scoreboard.held = false));

  // Handy for debugging from the browser console; stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { game: session });

  const keyboard = new Keyboard();
  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    // Clamp long frames (e.g. background tab) so we don't simulate a huge backlog at once.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const { transforms, events } = session.update(frameDt, () => keyboard.sample());
    renderer.render(session.world, transforms, session.myPedId, frameDt, events);
    wasted.update(session, events);
    for (const event of events) if (event.type === 'death') killFeed.add(session, event);
    scoreboard.update(session);
    const others = otherPlayers(session, transforms);
    nameTags.update(nameTagsFor(others, renderer));
    updateArrows(arrows, session, others, transforms, renderer);

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

interface OtherPlayer {
  player: PlayerInfo;
  ped: Ped;
  /** Where they're drawn: their ped on foot, or the car they're driving. */
  position: Transform;
}

function otherPlayers(session: GameSession, transforms: TransformSnapshot): OtherPlayer[] {
  const result: OtherPlayer[] = [];
  for (const player of session.players) {
    if (player.pedId === session.myPedId) continue;
    const ped = session.world.peds.get(player.pedId);
    if (ped) result.push({ player, ped, position: transforms.get(ped.carId ?? ped.id) ?? ped });
  }
  return result;
}

function nameTagsFor(others: readonly OtherPlayer[], renderer: GameRenderer): NameTag[] {
  const tags: NameTag[] = [];
  for (const { player, position } of others) {
    const screen = renderer.projectToScreen(position.x, position.y, NAME_TAG_HEIGHT);
    if (screen) tags.push({ id: player.pedId, text: player.name, ...screen });
  }
  return tags;
}

/** GTA2-style arrows circling our character, pointing at every other living player. */
function updateArrows(
  arrows: PlayerArrows,
  session: GameSession,
  others: readonly OtherPlayer[],
  transforms: TransformSnapshot,
  renderer: GameRenderer,
): void {
  const me = session.myPedId === null ? undefined : session.world.peds.get(session.myPedId);
  if (!me) return arrows.update([], 0, 0);
  const myPosition = transforms.get(me.carId ?? me.id) ?? me;
  const { width, height } = renderer.viewportSize();
  const origin = renderer.projectToScreen(myPosition.x, myPosition.y, 0) ?? { x: width / 2, y: height / 2 };

  const list: PlayerArrow[] = [];
  for (const { player, ped, position } of others) {
    if (isDead(ped)) continue;
    list.push({
      id: player.pedId,
      name: player.name,
      color: ped.color,
      // The camera looks straight down with north up, so world +y is screen -y.
      dx: position.x - myPosition.x,
      dy: -(position.y - myPosition.y),
    });
  }
  arrows.update(list, origin.x, origin.y);
}

function hudText(session: GameSession, fps: number, pack: AssetPack): string {
  const world = session.world;
  const ped = session.myPedId === null ? undefined : world.peds.get(session.myPedId);
  const car = ped?.carId != null ? world.cars.get(ped.carId) : undefined;
  const status = car ? `Driving: ${CAR_MODELS[car.model].name}  ${Math.round(carSpeed(car) * 10)} km/h` : 'On foot';
  const health = ped ? Math.ceil(ped.health) : 0;
  const bars = Math.ceil((health / PED_MAX_HEALTH) * 10);
  const healthLine = `Health: ${'█'.repeat(bars)}${'░'.repeat(10 - bars)} ${health}`;
  const weapon = ped?.weapon ? `Weapon: ${WEAPONS[ped.weapon].name} · ${ped.ammo[ped.weapon] ?? 0}` : 'Unarmed (walk over a spinning crate)';
  const me = session.players.find((p) => p.pedId === session.myPedId);
  const others = session.players.filter((p) => p !== me).map((p) => p.name);
  return [
    healthLine,
    status,
    weapon,
    '',
    'Arrows/WASD  move / steer',
    'Enter or F   get in / out of car',
    'Space        handbrake',
    'J or Ctrl    fire',
    'Z / X        switch weapon',
    session.match ? 'Tab          scores' : '',
    '',
    me && session instanceof NetworkSession ? `You are ${me.name}` : '',
    others.length > 0 ? `Also here: ${others.join(', ')}` : '',
    session.status,
    `${Math.round(fps)} fps · tick ${world.tick} · assets: ${pack.name}`,
  ]
    .filter((line, i, lines) => line !== '' || lines[i - 1] !== '')
    .join('\n');
}

/** The big red "WASTED" overlay, with who did it and a respawn countdown. */
class WastedScreen {
  private readonly element = document.getElementById('wasted')!;
  private readonly cause = document.getElementById('wasted-cause')!;
  private readonly countdown = document.getElementById('wasted-countdown')!;

  update(session: GameSession, events: readonly GameEvent[]): void {
    const me = session.myPedId;
    for (const event of events) {
      if (event.type === 'death' && event.pedId === me) this.cause.textContent = describeOwnDeath(session, event);
    }
    const ped = me === null ? undefined : session.world.peds.get(me);
    const respawnAt = ped?.respawnAt ?? null;
    this.element.hidden = respawnAt === null;
    if (respawnAt !== null) {
      const seconds = Math.max(1, Math.ceil((respawnAt - session.world.tick) / TICK_RATE));
      this.countdown.textContent = `Back in ${seconds}...`;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  document.getElementById('hud')!.textContent = `Failed to start: ${String(error)}`;
});

import type { PlayerInput } from '@game/shared';

const BINDINGS: Record<string, keyof PlayerInput> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'handbrake',
  Enter: 'enter',
  KeyF: 'enter',
  ControlLeft: 'fire',
  ControlRight: 'fire',
  KeyJ: 'fire',
};

/** Turns keyboard state into a PlayerInput once per simulation tick. */
export class Keyboard {
  private readonly held = new Set<string>();
  /** Keys pressed since the last sample, so a quick tap between two ticks isn't lost. */
  private readonly tapped = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!(e.code in BINDINGS)) return;
      e.preventDefault();
      this.held.add(e.code);
      this.tapped.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  sample(): PlayerInput {
    const input: PlayerInput = { up: false, down: false, left: false, right: false, fire: false, handbrake: false, enter: false };
    for (const code of this.held) input[BINDINGS[code]!] = true;
    for (const code of this.tapped) input[BINDINGS[code]!] = true;
    this.tapped.clear();
    return input;
  }
}

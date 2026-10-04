/**
 * Points popping up where they were earned, as in GTA2: "+100" over a wrecked car, "+10" over a
 * pedestrian, rising and fading in a moment (losses in red). Only your own points.
 */

/** How long a pop-up stays, and how far it rises (in CSS pixels). */
const LIFETIME = 1.4;
const RISE = 48;

interface Popup {
  element: HTMLElement;
  x: number;
  y: number;
  age: number;
}

export class PointPopups {
  private readonly popups: Popup[] = [];

  constructor(private readonly container: HTMLElement) {}

  add(points: number, x: number, y: number): void {
    const element = document.createElement('div');
    element.className = points < 0 ? 'popup loss' : 'popup';
    element.textContent = points > 0 ? `+${points}` : String(points);
    this.container.append(element);
    this.popups.push({ element, x, y, age: 0 });
  }

  /** Moves them along; `project` turns a point in the world (at a height) into screen pixels. */
  update(dt: number, project: (x: number, y: number, z: number) => { x: number; y: number } | null): void {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const popup = this.popups[i]!;
      popup.age += dt;
      const screen = project(popup.x, popup.y, 0.6);
      if (popup.age >= LIFETIME) {
        popup.element.remove();
        this.popups.splice(i, 1);
        continue;
      }
      const t = popup.age / LIFETIME;
      popup.element.hidden = screen === null;
      if (!screen) continue;
      // A quick pop in size at first, then rising and fading out.
      const scale = t < 0.15 ? 0.6 + (t / 0.15) * 0.6 : 1.2 - Math.min(t - 0.15, 0.2);
      popup.element.style.transform = `translate(${screen.x}px, ${screen.y - t * RISE}px) translate(-50%, -100%) scale(${scale})`;
      popup.element.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
    }
  }
}

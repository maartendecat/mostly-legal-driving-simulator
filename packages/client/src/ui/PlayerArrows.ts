export interface PlayerArrow {
  id: number;
  name: string;
  /** The player's character colour, as 0xRRGGBB. */
  color: number;
  /** Screen-space direction from us to them (x right, y down); needn't be normalised. */
  dx: number;
  dy: number;
}

/** Arrow size in CSS pixels (it points right before rotation). */
const ARROW_WIDTH = 64;
const ARROW_HEIGHT = 48;
/** How far from our character the arrows circle, as a fraction of the smaller screen side. */
const ORBIT_FRACTION = 0.2;
const MIN_ORBIT = 80;
const MAX_ORBIT = 150;
/** Keeps arrows this far inside the screen edges, in CSS pixels. */
const EDGE_MARGIN = 40;

export function orbitRadius(width: number, height: number): number {
  return Math.min(Math.max(Math.min(width, height) * ORBIT_FRACTION, MIN_ORBIT), MAX_ORBIT);
}

/**
 * Where an arrow goes: `radius` pixels from `origin` (our character on screen) in direction
 * (dx, dy), pulled back inside the screen if the origin is near an edge.
 */
export function arrowPosition(
  originX: number,
  originY: number,
  dx: number,
  dy: number,
  radius: number,
  width: number,
  height: number,
  margin = EDGE_MARGIN,
): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  const x = length === 0 ? originX : originX + (dx / length) * radius;
  const y = length === 0 ? originY : originY + (dy / length) * radius;
  return {
    x: Math.min(Math.max(x, margin), Math.max(margin, width - margin)),
    y: Math.min(Math.max(y, margin), Math.max(margin, height - margin)),
  };
}

const SVG = 'http://www.w3.org/2000/svg';
/** A classic block arrow (shaft and head) pointing right, in a 64×48 box. */
const ARROW_POINTS = '4,15 33,15 33,4 61,24 33,44 33,33 4,33';

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * GTA2-style player arrows: big block arrows circling our character, pointing at every other living
 * player. Drawn as an outline in the player's colour with a see-through inside.
 */
export class PlayerArrows {
  private readonly elements = new Map<number, { root: HTMLElement; icon: SVGSVGElement; label: HTMLElement }>();

  constructor(private readonly container: HTMLElement) {}

  /** `originX/Y`: our own character on screen, in CSS pixels. */
  update(arrows: readonly PlayerArrow[], originX: number, originY: number): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const radius = orbitRadius(width, height);
    const seen = new Set<number>();
    for (const arrow of arrows) {
      seen.add(arrow.id);
      const element = this.elements.get(arrow.id) ?? this.create(arrow);
      const { x, y } = arrowPosition(originX, originY, arrow.dx, arrow.dy, radius, width, height);
      element.root.style.transform = `translate(${x}px, ${y}px)`;
      element.icon.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(arrow.dy, arrow.dx)}rad)`;
      // Names are typed by other players, so they only ever go in as text.
      if (element.label.textContent !== arrow.name) element.label.textContent = arrow.name;
    }
    for (const [id, element] of this.elements) {
      if (seen.has(id)) continue;
      element.root.remove();
      this.elements.delete(id);
    }
  }

  private create(arrow: PlayerArrow) {
    const root = document.createElement('div');
    root.className = 'player-arrow';

    const icon = document.createElementNS(SVG, 'svg');
    icon.setAttribute('viewBox', '0 0 64 48');
    icon.setAttribute('width', String(ARROW_WIDTH));
    icon.setAttribute('height', String(ARROW_HEIGHT));
    icon.classList.add('icon');

    // A thin dark halo under the coloured outline keeps it readable on any background.
    for (const [stroke, width] of [
      ['rgba(0, 0, 0, 0.55)', '6'],
      [hex(arrow.color), '3'],
    ] as const) {
      const outline = document.createElementNS(SVG, 'polygon');
      outline.setAttribute('points', ARROW_POINTS);
      outline.setAttribute('fill', 'none');
      outline.setAttribute('stroke', stroke);
      outline.setAttribute('stroke-width', width);
      outline.setAttribute('stroke-linejoin', 'round');
      icon.append(outline);
    }

    const label = document.createElement('div');
    label.className = 'label';
    root.append(icon, label);
    this.container.append(root);
    const element = { root, icon, label };
    this.elements.set(arrow.id, element);
    return element;
  }
}

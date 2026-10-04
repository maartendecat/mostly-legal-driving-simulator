import * as THREE from 'three';
import { CAR_MODELS, DIRECTIONS, HELICOPTER_HEALTH, type BlockMap, type Car, type CarModel, type Helicopter } from '@game/shared';

/** Building blocks shared by the asset packs. */

export function box(x: number, y: number, z: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(x, y, z), new THREE.MeshLambertMaterial({ color }));
}

/** A stable pseudo-random value in [0, 1) for a map cell, for per-cell variation. */
export function hash(x: number, y: number): number {
  const h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
  return ((h >>> 0) % 1000) / 1000;
}

/** Disposes every geometry and material under `root`. Shared resources must not be under it. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
    }
  });
}

/** How damaged a car looks, from 0 (new) to 1 (wreck). */
export function carDamage(car: Car): number {
  return car.wrecked ? 1 : 1 - car.health / CAR_MODELS[car.model].health;
}

/**
 * A fire truck's water cannon: drops of water arcing from the roof to where it's spraying
 * (`car.spray`, in world coordinates; the view is in the car's own frame).
 */
export class WaterJet {
  readonly object = new THREE.Group();
  private readonly drops: THREE.Mesh[] = [];
  private time = 0;

  constructor(
    private readonly nozzle: THREE.Vector3,
    count = 14,
  ) {
    const material = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.75 });
    const geometry = new THREE.SphereGeometry(0.07, 8, 6);
    for (let i = 0; i < count; i++) {
      const drop = new THREE.Mesh(geometry, material);
      this.drops.push(drop);
      this.object.add(drop);
    }
    this.object.visible = false;
  }

  update(dt: number, car: Car): void {
    this.object.visible = car.spray !== null;
    if (!car.spray) return;
    this.time += dt;
    // The target in the car's frame (x forward, y left).
    const dx = car.spray.x - car.x;
    const dy = car.spray.y - car.y;
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    const tx = dx * cos + dy * sin;
    const ty = -dx * sin + dy * cos;
    this.drops.forEach((drop, i) => {
      const t = (this.time * 1.6 + i / this.drops.length) % 1;
      drop.position.set(
        this.nozzle.x + (tx - this.nozzle.x) * t,
        this.nozzle.y + (ty - this.nozzle.y) * t,
        this.nozzle.z * (1 - t) + 0.15 * t + Math.sin(Math.PI * t) * 0.6,
      );
      drop.scale.setScalar(0.7 + t * 0.8);
    });
  }

  dispose(): void {
    this.drops[0]?.geometry.dispose();
    (this.drops[0]?.material as THREE.Material | undefined)?.dispose();
  }
}

/** Smoke when a car is badly damaged, flames while it burns before exploding and while a wreck burns. */
export class CarDamageEffects {
  readonly object = new THREE.Group();
  private readonly smoke: THREE.Mesh;
  private readonly flames = new THREE.Group();
  private time = Math.random() * 10;

  constructor(model: CarModel, height = 0.55) {
    this.smoke = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 }));
    this.smoke.position.set(model.length * 0.3, 0, height);
    for (let i = 0; i < 3; i++) {
      const flame = box(0.26, 0.26, 0.35, i === 1 ? 0xffd23f : 0xff6a00);
      (flame.material as THREE.MeshLambertMaterial).emissive.setHex(i === 1 ? 0xffb000 : 0xff4000);
      flame.position.set(model.length * 0.25 - i * 0.15, (i - 1) * 0.15, height);
      this.flames.add(flame);
    }
    this.object.add(this.smoke, this.flames);
  }

  update(dt: number, car: Car): void {
    this.time += dt;
    const burning = (car.explodeAt !== null && !car.wrecked) || (car.wrecked && car.burnsUntil !== null);
    this.flames.visible = burning;
    if (burning) this.flames.children.forEach((flame, i) => flame.scale.setScalar(0.8 + 0.4 * Math.abs(Math.sin(this.time * 12 + i * 2))));
    this.smoke.visible = !burning && carDamage(car) > 0.6;
    if (this.smoke.visible) this.smoke.scale.setScalar(1 + 0.25 * Math.sin(this.time * 3));
  }
}

/** The pool of blood under a dead ped, growing over the first second. */
export class BloodPool {
  readonly object: THREE.Mesh;
  private deadFor = 0;

  constructor() {
    this.object = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), new THREE.MeshBasicMaterial({ color: 0x6d0a0a }));
    this.object.position.set(-0.25, 0, 0.015);
  }

  update(dt: number, dead: boolean): void {
    this.deadFor = dead ? this.deadFor + dt : 0;
    this.object.visible = dead;
    this.object.scale.setScalar(Math.min(0.2 + this.deadFor, 1));
  }
}

/** Distance walked (in blocks) for one full walk cycle: a step with each foot. */
const STRIDE_LENGTH = 0.9;
/**
 * How far a foot reaches forward (and back) from under the body, in blocks. Mid-stride the feet
 * stick out past the shoulders (about 0.18 from the centre), as in GTA2.
 */
const FOOT_REACH = 0.24;
/** How far the upper body turns with each step, in radians. */
const BODY_SWAY = 0.12;
/** Moves longer than this in one frame are teleports (respawning), not steps. */
const MAX_STEP = 1;

/**
 * A GTA2-style walk cycle drawn in code: two feet stepping out in front of and behind the body,
 * and the upper body swaying along. It's driven by how far the ped actually moved on screen, so
 * it works for predicted and remote peds alike, feet never slide, and walking backwards reverses it.
 */
export class WalkAnimation {
  readonly feet = new THREE.Group();
  private readonly left: THREE.Mesh;
  private readonly right: THREE.Mesh;
  private phase = 0;
  /** 0 when standing, 1 when walking; blends between the two so starting and stopping look soft. */
  private stepping = 0;
  private last: { x: number; y: number } | null = null;

  constructor(color = 0x6b4a33, spread = 0.08) {
    // Brown shoes with a dark outline, so they show on dark asphalt as well as light pavement.
    const shoe = new THREE.BoxGeometry(0.15, 0.09, 0.04);
    const outline = new THREE.BoxGeometry(0.19, 0.13, 0.02);
    const material = new THREE.MeshBasicMaterial({ color });
    const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x141414 });
    const foot = () => {
      const group = new THREE.Mesh(shoe, material);
      const edge = new THREE.Mesh(outline, outlineMaterial);
      edge.position.z = -0.02;
      group.add(edge);
      return group;
    };
    this.left = foot();
    this.right = foot();
    this.left.position.y = spread;
    this.right.position.y = -spread;
    this.feet.add(this.left, this.right);
  }

  /**
   * Advances the animation for a ped drawn at `x, y` facing `heading` this frame. `active` is false
   * when the feet shouldn't show (dead). Returns the body sway to apply this frame, in radians.
   */
  update(dt: number, x: number, y: number, heading: number, active: boolean): number {
    let forward = 0;
    if (this.last && active) {
      const dx = x - this.last.x;
      const dy = y - this.last.y;
      if (Math.hypot(dx, dy) < MAX_STEP) forward = dx * Math.cos(heading) + dy * Math.sin(heading);
    }
    this.last = { x, y };

    const walking = active && dt > 0 && Math.abs(forward) / dt > 0.3;
    this.phase += (forward / STRIDE_LENGTH) * Math.PI * 2;
    this.stepping += ((walking ? 1 : 0) - this.stepping) * (1 - Math.exp(-dt * 12));

    const swing = Math.sin(this.phase) * this.stepping;
    this.left.position.x = swing * FOOT_REACH;
    this.right.position.x = -swing * FOOT_REACH;
    this.feet.visible = active;
    return swing * BODY_SWAY;
  }

  /** Where the left foot is along the walking direction (for tests). */
  get leftFootX(): number {
    return this.left.position.x;
  }

  dispose(): void {
    const edge = this.left.children[0] as THREE.Mesh;
    for (const mesh of [this.left, edge]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}

/**
 * A tank built from boxes and cylinders (until a CC0 model replaces it): tracks, a hull, and a
 * turret with a long barrel that turns on its own (`car.turret` is an absolute heading; the view
 * sits in the hull's frame).
 */
export function createTankView(car: Car): { object: THREE.Group; update: (dt: number, state: Car) => void } {
  const m = CAR_MODELS[car.model];
  const group = new THREE.Group();
  const olive = 0x4b5d3a;
  for (const side of [1, -1]) {
    const track = box(m.length, m.width * 0.24, 0.26, 0x26261f);
    track.position.set(0, side * m.width * 0.38, 0.13);
    group.add(track);
  }
  const hull = box(m.length * 0.92, m.width * 0.62, 0.3, olive);
  hull.position.z = 0.3;
  group.add(hull);
  const turret = new THREE.Group();
  turret.position.z = 0.5;
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(m.width * 0.3, m.width * 0.34, 0.2, 16), new THREE.MeshLambertMaterial({ color: 0x55683f }));
  dome.rotation.x = Math.PI / 2;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, m.length * 0.75, 10), new THREE.MeshLambertMaterial({ color: 0x2f3a26 }));
  barrel.rotation.z = -Math.PI / 2;
  barrel.position.x = m.length * 0.38;
  turret.add(dome, barrel);
  group.add(turret);
  const effects = new CarDamageEffects(m, 0.75);
  group.add(effects.object);
  const materials = [hull, dome, barrel].map((mesh) => mesh.material as THREE.MeshLambertMaterial);
  const colors = materials.map((material) => material.color.clone());
  const burnt = new THREE.Color(0x1c1c1c);
  return {
    object: group,
    update: (dt, state) => {
      turret.rotation.z = state.turret - state.heading;
      materials.forEach((material, i) => material.color.copy(colors[i]!).lerp(burnt, state.wrecked ? 0.85 : carDamage(state) * 0.5));
      effects.update(dt, state);
    },
  };
}

/**
 * A helicopter built from shapes (until a CC0 model replaces it), flying `altitude` blocks up with
 * its shadow on the ground below; the rotor spins, faster while it flies, and it smokes and burns
 * as it comes down.
 */
export function createHelicopterView(): { object: THREE.Group; update: (dt: number, state: Helicopter) => void; dispose: () => void } {
  const group = new THREE.Group();
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
  shadow.position.z = 0.03;
  shadow.scale.set(1.6, 0.8, 1);
  const craft = new THREE.Group();
  const olive = 0x4b5320;
  const body = box(1.3, 0.55, 0.5, olive);
  const nose = box(0.35, 0.45, 0.35, 0x9fc5d8); // the cockpit glass
  nose.position.set(0.75, 0, -0.03);
  const tail = box(1.2, 0.14, 0.14, olive);
  tail.position.set(-1.15, 0, 0.1);
  const fin = box(0.25, 0.06, 0.35, olive);
  fin.position.set(-1.7, 0, 0.25);
  const skids = [1, -1].map((side) => {
    const skid = box(1.2, 0.06, 0.06, 0x222222);
    skid.position.set(0, side * 0.32, -0.32);
    return skid;
  });
  const rotor = new THREE.Group();
  for (const angle of [0, Math.PI / 2]) {
    const blade = box(3.2, 0.12, 0.03, 0x1b1b1b);
    blade.rotation.z = angle;
    rotor.add(blade);
  }
  rotor.position.z = 0.32;
  const tailRotor = box(0.04, 0.6, 0.06, 0x1b1b1b);
  tailRotor.position.set(-1.7, 0.06, 0.3);
  craft.add(body, nose, tail, fin, ...skids, rotor, tailRotor);
  const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.6 }));
  const flame = box(0.35, 0.35, 0.35, 0xff6a00);
  (flame.material as THREE.MeshLambertMaterial).emissive.setHex(0xff4000);
  smoke.position.set(-0.3, 0, 0.5);
  flame.position.set(-0.1, 0, 0.3);
  craft.add(smoke, flame);
  group.add(shadow, craft);
  let time = 0;
  return {
    object: group,
    update: (dt, state) => {
      time += dt;
      craft.position.z = state.altitude;
      rotor.rotation.z += dt * 30;
      tailRotor.rotation.y += dt * 40;
      const down = state.crashAt !== null;
      smoke.visible = flame.visible = down || state.health < HELICOPTER_HEALTH * 0.4;
      flame.visible = down;
      smoke.scale.setScalar(1 + 0.3 * Math.sin(time * 5));
      // The shadow shrinks as it flies higher.
      shadow.scale.set(1.6 - state.altitude * 0.05, 0.8 - state.altitude * 0.025, 1);
    },
    dispose: () => disposeObject(group),
  };
}

/**
 * The spray shops (see BlockMap.sprayShops): a garage door with a SPRAY sign on the building
 * behind each bay, and yellow stripes marking the bay on the pavement. Drawn in code for any pack.
 */
export function createSprayShops(map: BlockMap): THREE.Object3D {
  const group = new THREE.Group();
  if (map.sprayShops.length === 0) return group;
  const door = new THREE.MeshLambertMaterial({ map: canvasTexture(128, 96, drawSprayDoor) });
  const bay = new THREE.MeshBasicMaterial({ map: canvasTexture(64, 64, drawSprayBay), transparent: true });
  for (const shop of map.sprayShops) {
    const d = DIRECTIONS[shop.dir]!;
    // The door: upright on the building's face, looking out over the bay.
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.85), door);
    front.position.set(shop.x + d.dx * 0.505, shop.y + d.dy * 0.505, 0.43);
    // Stood up (facing -y), then turned to face out of the building, towards the bay (-d).
    front.rotation.set(Math.PI / 2, 0, Math.atan2(-d.dx, d.dy), 'ZXY');
    const marks = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), bay);
    marks.position.set(shop.x, shop.y, 0.012);
    marks.rotation.z = Math.atan2(d.dy, d.dx);
    group.add(front, marks);
  }
  return group;
}

function canvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A roller door with a sign above it: SPRAY, in paint colours. */
function drawSprayDoor(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#9aa3ab';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#7d868e';
  for (let y = h * 0.3; y < h; y += 7) g.fillRect(4, y, w - 8, 3);
  const sign = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#9b59b6'];
  g.fillStyle = '#1b1b1b';
  g.fillRect(0, 0, w, h * 0.27);
  g.font = `bold ${Math.round(h * 0.22)}px sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  [...'SPRAY'].forEach((letter, i) => {
    g.fillStyle = sign[i]!;
    g.fillText(letter, w * (0.18 + i * 0.16), h * 0.14);
  });
}

/** The bay: diagonal yellow stripes along its edges. */
function drawSprayBay(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.strokeStyle = '#f1c40f';
  g.lineWidth = 4;
  g.strokeRect(3, 3, w - 6, h - 6);
  g.lineWidth = 3;
  for (let i = -h; i < w; i += 12) {
    g.beginPath();
    g.moveTo(i, h);
    g.lineTo(i + 8, h - 8);
    g.stroke();
  }
}

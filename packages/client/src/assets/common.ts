import * as THREE from 'three';
import { CAR_MODELS, type Car, type CarModel } from '@game/shared';

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

/** Smoke when a car is badly damaged, flames while it burns before exploding. */
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
    const burning = car.explodeAt !== null && !car.wrecked;
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

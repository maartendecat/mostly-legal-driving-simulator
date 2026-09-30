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

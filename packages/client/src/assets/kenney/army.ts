import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CAR_MODELS, HELICOPTER_HEALTH, type Car, type Helicopter } from '@game/shared';
import type { EntityView } from '../AssetPack';
import { CarDamageEffects, carDamage, disposeObject } from '../common';

/**
 * The army's tank and helicopter, from CC0 models on poly.pizza: "Tank" by Quaternius and
 * "Helicopter" by kazuma (files in public/assets/army/). Both are loaded once, turned into our axes
 * (+x forward, +z up), scaled to the game's sizes, and cloned for each tank and helicopter.
 */

const BASE = `${import.meta.env.BASE_URL}assets/army/`;

/**
 * The tank model faces -x with y up; ours face +x with z up. Columns: model x → -x, y → +z, z → +y
 * (a proper rotation, so turning about the model's up axis is turning about ours).
 */
const TANK_TO_WORLD = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
/** The helicopter model faces +z with y up, like the Car Kit: model z → +x, x → +y, y → +z. */
const HELICOPTER_TO_WORLD = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
/** The tank model is this wide (across its tracks), in its own units. */
const TANK_MODEL_WIDTH = 10.1;
/** How long the helicopter is drawn, nose to tail (in blocks). */
const HELICOPTER_LENGTH = 2.6;
/** The helicopter's civilian red and black, repainted army olive. */
const HELICOPTER_PAINT: Record<string, number> = {
  'Material.001': 0x4b5320, // body
  'Material.003': 0x3d4a1c, // trim
  'Material.004': 0xa9c6d6, // cockpit glass
};

export interface ArmyModels {
  tank: THREE.Object3D;
  helicopter: THREE.Object3D;
}

export async function loadArmyModels(gltf: GLTFLoader): Promise<ArmyModels> {
  const [tank, helicopter] = await Promise.all([gltf.loadAsync(`${BASE}tank.glb`), gltf.loadAsync(`${BASE}helicopter.glb`)]);
  return { tank: prepareTank(tank.scene), helicopter: prepareHelicopter(helicopter.scene) };
}

/**
 * The tank in our axes and size, with its gun attached to the turret (they're separate in the
 * model), both under a pivot at the turret's centre, named 'turretPivot'.
 */
function prepareTank(scene: THREE.Group): THREE.Object3D {
  scene.updateMatrixWorld(true);
  const turret = scene.getObjectByName('Tank_Turret')!;
  const gun = scene.getObjectByName('Tank_Gun')!;
  const ring = new THREE.Box3().setFromObject(scene.getObjectByName('Tank_Turret_1')!).getCenter(new THREE.Vector3());
  const pivot = new THREE.Group();
  pivot.name = 'turretPivot';
  pivot.position.set(ring.x, 0, ring.z);
  turret.parent!.add(pivot);
  pivot.updateMatrixWorld(true);
  pivot.attach(turret);
  pivot.attach(gun);
  const model = new THREE.Group();
  scene.applyMatrix4(TANK_TO_WORLD);
  model.add(scene);
  model.scale.setScalar(CAR_MODELS.tank.width / TANK_MODEL_WIDTH);
  return model;
}

/** The helicopter in our axes and size, centred, olive, with its rotor spinning about its own middle ('rotor'). */
function prepareHelicopter(scene: THREE.Group): THREE.Object3D {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const material = obj.material as THREE.MeshStandardMaterial;
    const paint = HELICOPTER_PAINT[material.name];
    if (paint !== undefined) material.color.setHex(paint);
    if (material.name === 'Material.002') {
      // The rotor: re-centred, so it spins in place.
      obj.geometry.computeBoundingBox();
      const centre = obj.geometry.boundingBox!.getCenter(new THREE.Vector3());
      obj.geometry.translate(-centre.x, -centre.y, -centre.z);
      obj.position.add(centre);
      obj.name = 'rotor';
    }
  });
  scene.applyMatrix4(HELICOPTER_TO_WORLD);
  const model = new THREE.Group();
  model.add(scene);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  scene.position.sub(new THREE.Vector3(centre.x, centre.y, bounds.min.z));
  model.scale.setScalar(HELICOPTER_LENGTH / size.x);
  return model;
}

/** A tank: the model, its turret turning on its own, darkening with damage, smoking, burning. */
export function createTankModelView(models: ArmyModels, car: Car): EntityView<Car> {
  const group = new THREE.Group();
  const tank = cloneSkinned(models.tank);
  const pivot = tank.getObjectByName('turretPivot')!;
  const materials: THREE.MeshStandardMaterial[] = [];
  tank.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.material = (obj.material as THREE.MeshStandardMaterial).clone();
      materials.push(obj.material);
    }
  });
  const colours = materials.map((m) => m.color.clone());
  const effects = new CarDamageEffects(CAR_MODELS[car.model], 0.55);
  group.add(tank, effects.object);
  const burnt = new THREE.Color(0x1c1c1c);
  return {
    object: group,
    update: (dt, state) => {
      pivot.rotation.y = state.turret - state.heading;
      const damage = state.wrecked ? 0.85 : carDamage(state) * 0.5;
      materials.forEach((material, i) => material.color.copy(colours[i]!).lerp(burnt, damage));
      effects.update(dt, state);
    },
    dispose: () => {
      materials.forEach((material) => material.dispose());
      effects.object.traverse((obj) => obj instanceof THREE.Mesh && (obj.geometry.dispose(), (obj.material as THREE.Material).dispose()));
    },
  };
}

/**
 * A helicopter: the model `altitude` blocks up, its rotor spinning, with its shadow on the ground
 * below; smoking when badly hit, burning as it comes down.
 */
export function createHelicopterModelView(models: ArmyModels): EntityView<Helicopter> {
  const group = new THREE.Group();
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
  shadow.position.z = 0.03;
  const craft = models.helicopter.clone(true);
  const rotor = craft.getObjectByName('rotor')!;
  const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.6 }));
  smoke.position.set(-0.3, 0, 0.9);
  const flame = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), new THREE.MeshLambertMaterial({ color: 0xff6a00, emissive: 0xff4000 }));
  flame.position.set(-0.1, 0, 0.6);
  const lift = new THREE.Group();
  lift.add(craft, smoke, flame);
  group.add(shadow, lift);
  let time = 0;
  return {
    object: group,
    update: (dt, state) => {
      time += dt;
      lift.position.z = state.altitude;
      rotor.rotation.y += dt * 30;
      const down = state.crashAt !== null;
      smoke.visible = down || state.health < HELICOPTER_HEALTH * 0.4;
      flame.visible = down;
      smoke.scale.setScalar(1 + 0.3 * Math.sin(time * 5));
      // The shadow shrinks as it flies higher.
      shadow.scale.set(1.6 - state.altitude * 0.05, 0.8 - state.altitude * 0.025, 1);
    },
    dispose: () => {
      disposeObject(shadow);
      smoke.geometry.dispose();
      (smoke.material as THREE.Material).dispose();
      flame.geometry.dispose();
      (flame.material as THREE.Material).dispose();
    },
  };
}

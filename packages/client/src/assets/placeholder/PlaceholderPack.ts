import * as THREE from 'three';
import { Block, CAR_MODELS, PED_RADIUS, RoadMarking, type BlockMap, type Car, type Ped } from '@game/shared';
import type { AssetPack, EntityView } from '../AssetPack';

const GROUND_COLORS: Record<number, number> = {
  [Block.Road]: 0x3a3a3f,
  [Block.Pavement]: 0x8c8980,
  [Block.Grass]: 0x4a7d3c,
  [Block.Water]: 0x2d5f8f,
};
const BUILDING_COLORS = [0x9a6b52, 0x7d7f86, 0xb3a58a, 0x6a5a7a, 0x8a4f4a, 0x5f7468];
const MARKING_COLOR = 0xe8e2c8;

/** Flat-coloured boxes. Needs no files, so it's always available and useful for testing gameplay. */
export class PlaceholderPack implements AssetPack {
  readonly id = 'placeholder';
  readonly name = 'Placeholder shapes';

  async load(): Promise<void> {}

  buildMap(map: BlockMap): THREE.Object3D {
    const ground: number[] = [];
    const buildings: number[] = [];
    const markings: number[] = [];
    for (let i = 0; i < map.kinds.length; i++) {
      if (map.kinds[i] === Block.Building) {
        buildings.push(i);
      } else {
        ground.push(i);
        if (hasDash(map, i)) markings.push(i);
      }
    }

    const group = new THREE.Group();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    const groundMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial(), ground.length);
    ground.forEach((cell, n) => {
      const x = cell % map.width;
      const y = Math.floor(cell / map.width);
      groundMesh.setMatrixAt(n, matrix.makeTranslation(x + 0.5, y + 0.5, 0));
      // Slight per-cell brightness noise so the ground doesn't look like one flat sheet.
      color.setHex(GROUND_COLORS[map.kinds[cell]!] ?? 0xff00ff).offsetHSL(0, 0, (hash(x, y) - 0.5) * 0.012);
      groundMesh.setColorAt(n, color);
    });
    group.add(groundMesh);

    // Dashed centre lines: a short dash in the middle of every other marked road cell.
    const markingMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({ color: MARKING_COLOR }),
      markings.length,
    );
    markings.forEach((cell, n) => {
      const x = cell % map.width;
      const y = Math.floor(cell / map.width);
      const horizontal = map.variants[cell] === RoadMarking.CenterHorizontal;
      position.set(x + 0.5, y + 0.5, 0.01);
      scale.set(horizontal ? 0.5 : 0.06, horizontal ? 0.06 : 0.5, 1);
      markingMesh.setMatrixAt(n, matrix.compose(position, rotation, scale));
    });
    group.add(markingMesh);

    const buildingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), buildings.length);
    buildings.forEach((cell, n) => {
      const x = cell % map.width;
      const y = Math.floor(cell / map.width);
      const levels = Math.max(1, map.levels[cell]!);
      position.set(x + 0.5, y + 0.5, levels / 2);
      scale.set(1, 1, levels);
      buildingMesh.setMatrixAt(n, matrix.compose(position, rotation, scale));
      color.setHex(BUILDING_COLORS[map.variants[cell]! % BUILDING_COLORS.length]!).offsetHSL(0, 0, (hash(x, y) - 0.5) * 0.03);
      buildingMesh.setColorAt(n, color);
    });
    group.add(buildingMesh);

    return group;
  }

  createCarView(car: Car): EntityView {
    const m = CAR_MODELS[car.model];
    const group = new THREE.Group();
    const isTruck = car.model === 'truck';

    const body = box(m.length, m.width, 0.3, car.color);
    body.position.z = 0.15;
    group.add(body);

    // Truck: cab at the front. Others: cabin in the middle with a dark windscreen showing the front.
    const cabinLength = isTruck ? m.length * 0.3 : m.length * 0.45;
    const cabinX = isTruck ? m.length / 2 - cabinLength / 2 - 0.05 : -m.length * 0.05;
    const cabin = box(cabinLength, m.width * 0.85, 0.2, new THREE.Color(car.color).multiplyScalar(0.75).getHex());
    cabin.position.set(cabinX, 0, 0.4);
    group.add(cabin);

    const windscreen = box(0.07, m.width * 0.75, 0.17, 0x1d2b3a);
    windscreen.position.set(cabinX + cabinLength / 2, 0, 0.39);
    group.add(windscreen);

    for (const side of [1, -1]) {
      const light = box(0.04, 0.1, 0.08, 0xfff3b0);
      light.position.set(m.length / 2, side * (m.width / 2 - 0.08), 0.2);
      group.add(light);
    }

    return { object: group, dispose: () => disposeObject(group) };
  }

  createPedView(ped: Ped): EntityView {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color: ped.color });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(PED_RADIUS, PED_RADIUS, 0.45, 12), material);
    body.rotation.x = Math.PI / 2; // cylinders are Y-up in three.js; our world is Z-up
    body.position.z = 0.225;
    group.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshLambertMaterial({ color: 0xe0b08a }));
    head.position.z = 0.52;
    group.add(head);

    const nose = box(0.14, 0.06, 0.06, 0x222222);
    nose.position.set(PED_RADIUS, 0, 0.35);
    group.add(nose);

    return { object: group, dispose: () => disposeObject(group) };
  }
}

function hasDash(map: BlockMap, cell: number): boolean {
  const variant = map.variants[cell];
  if (map.kinds[cell] !== Block.Road || variant === RoadMarking.None) return false;
  const x = cell % map.width;
  const y = Math.floor(cell / map.width);
  return (variant === RoadMarking.CenterHorizontal ? x : y) % 2 === 0;
}

function box(x: number, y: number, z: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(x, y, z), new THREE.MeshLambertMaterial({ color }));
}

function hash(x: number, y: number): number {
  const h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
  return ((h >>> 0) % 1000) / 1000;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
    }
  });
}

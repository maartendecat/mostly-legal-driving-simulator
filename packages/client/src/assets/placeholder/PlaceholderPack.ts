import * as THREE from 'three';
import {
  Block,
  CAR_MODELS,
  PED_RADIUS,
  RoadMarking,
  type BlockMap,
  type Car,
  type GameEvent,
  type Ped,
  type Pickup,
  type Projectile,
  type WeaponId,
} from '@game/shared';
import type { AssetPack, EffectView, EntityView, PickupViewState } from '../AssetPack';

const GROUND_COLORS: Record<number, number> = {
  [Block.Road]: 0x3a3a3f,
  [Block.Pavement]: 0x8c8980,
  [Block.Grass]: 0x4a7d3c,
  [Block.Water]: 0x2d5f8f,
};
const BUILDING_COLORS = [0x9a6b52, 0x7d7f86, 0xb3a58a, 0x6a5a7a, 0x8a4f4a, 0x5f7468];
const MARKING_COLOR = 0xe8e2c8;
const WEAPON_COLORS: Record<WeaponId, number> = {
  pistol: 0xd7dde0,
  machineGun: 0x42a5f5,
  rocketLauncher: 0xef5350,
};
/** Height at which projectiles fly, roughly hand height. */
const PROJECTILE_HEIGHT = 0.35;

/** Flat-coloured boxes. Needs no files, so it's always available and useful for testing gameplay. */
export class PlaceholderPack implements AssetPack {
  readonly id = 'placeholder';
  readonly name = 'Placeholder shapes';

  /** Projectiles are frequent and identical, so they share geometry and materials. */
  private readonly bulletGeometry = new THREE.BoxGeometry(0.34, 0.08, 0.05);
  private readonly bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xffd400 });
  private readonly rocketGeometry = new THREE.BoxGeometry(0.3, 0.09, 0.09);
  private readonly rocketMaterial = new THREE.MeshLambertMaterial({ color: 0x9e9e9e });
  private readonly flameGeometry = new THREE.BoxGeometry(0.16, 0.07, 0.07);
  private readonly flameMaterial = new THREE.MeshBasicMaterial({ color: 0xff8c1a });

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

  createCarView(car: Car): EntityView<Car> {
    const m = CAR_MODELS[car.model];
    const group = new THREE.Group();
    const isTruck = car.model === 'truck';
    const paint = new THREE.Color(car.color);

    const body = box(m.length, m.width, 0.3, car.color);
    body.position.z = 0.15;
    group.add(body);

    // Truck: cab at the front. Others: cabin in the middle with a dark windscreen showing the front.
    const cabinLength = isTruck ? m.length * 0.3 : m.length * 0.45;
    const cabinX = isTruck ? m.length / 2 - cabinLength / 2 - 0.05 : -m.length * 0.05;
    const cabinPaint = paint.clone().multiplyScalar(0.75);
    const cabin = box(cabinLength, m.width * 0.85, 0.2, cabinPaint.getHex());
    cabin.position.set(cabinX, 0, 0.4);
    group.add(cabin);

    const windscreen = box(0.07, m.width * 0.75, 0.17, 0x1d2b3a);
    windscreen.position.set(cabinX + cabinLength / 2, 0, 0.39);
    group.add(windscreen);

    const lights: THREE.Mesh[] = [];
    for (const side of [1, -1]) {
      const light = box(0.04, 0.1, 0.08, 0xfff3b0);
      light.position.set(m.length / 2, side * (m.width / 2 - 0.08), 0.2);
      lights.push(light);
      group.add(light);
    }

    // Smoke when badly damaged, flames when it's about to blow.
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 }));
    smoke.position.set(m.length * 0.3, 0, 0.55);
    const flames = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const flame = box(0.26, 0.26, 0.35, i === 1 ? 0xffd23f : 0xff6a00);
      (flame.material as THREE.MeshLambertMaterial).emissive.setHex(i === 1 ? 0xffb000 : 0xff4000);
      flame.position.set(m.length * 0.25 - i * 0.15, (i - 1) * 0.15, 0.55);
      flames.add(flame);
    }
    group.add(smoke, flames);

    const bodyMaterial = body.material as THREE.MeshLambertMaterial;
    const cabinMaterial = cabin.material as THREE.MeshLambertMaterial;
    const burnt = new THREE.Color(0x1c1c1c);
    let time = Math.random() * 10;
    return {
      object: group,
      update: (dt, state) => {
        time += dt;
        const damage = state.wrecked ? 1 : 1 - state.health / CAR_MODELS[state.model].health;
        bodyMaterial.color.copy(paint).lerp(burnt, state.wrecked ? 1 : damage * 0.6);
        cabinMaterial.color.copy(cabinPaint).lerp(burnt, state.wrecked ? 1 : damage * 0.6);
        lights.forEach((light) => (light.visible = !state.wrecked));

        const burning = state.explodeAt !== null && !state.wrecked;
        flames.visible = burning;
        if (burning) flames.children.forEach((flame, i) => flame.scale.setScalar(0.8 + 0.4 * Math.abs(Math.sin(time * 12 + i * 2))));
        smoke.visible = !burning && (state.wrecked || damage > 0.6);
        if (smoke.visible) smoke.scale.setScalar(1 + 0.25 * Math.sin(time * 3));
      },
      dispose: () => disposeObject(group),
    };
  }

  createPedView(ped: Ped): EntityView<Ped> {
    const group = new THREE.Group();
    // Everything that falls over when the ped dies.
    const figure = new THREE.Group();
    group.add(figure);
    const material = new THREE.MeshLambertMaterial({ color: ped.color });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(PED_RADIUS, PED_RADIUS, 0.45, 12), material);
    body.rotation.x = Math.PI / 2; // cylinders are Y-up in three.js; our world is Z-up
    body.position.z = 0.225;
    figure.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshLambertMaterial({ color: 0xe0b08a }));
    head.position.z = 0.52;
    figure.add(head);

    const nose = box(0.14, 0.06, 0.06, 0x222222);
    nose.position.set(PED_RADIUS, 0, 0.35);
    figure.add(nose);

    const blood = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), new THREE.MeshBasicMaterial({ color: 0x6d0a0a }));
    blood.position.set(-0.25, 0, 0.015);
    group.add(blood);

    let deadFor = 0;
    return {
      object: group,
      update: (dt, state) => {
        const dead = state.respawnAt !== null;
        deadFor = dead ? deadFor + dt : 0;
        // Tip over backwards and lie flat on the ground.
        figure.rotation.y = dead ? -Math.PI / 2 : 0;
        figure.position.set(dead ? -0.05 : 0, 0, dead ? PED_RADIUS : 0);
        blood.visible = dead;
        blood.scale.setScalar(Math.min(0.2 + deadFor, 1));
      },
      dispose: () => disposeObject(group),
    };
  }

  createProjectileView(projectile: Projectile): EntityView<Projectile> {
    const group = new THREE.Group();
    if (projectile.kind === 'rocket') {
      const body = new THREE.Mesh(this.rocketGeometry, this.rocketMaterial);
      const flame = new THREE.Mesh(this.flameGeometry, this.flameMaterial);
      flame.position.x = -0.22;
      group.add(body, flame);
    } else {
      group.add(new THREE.Mesh(this.bulletGeometry, this.bulletMaterial));
    }
    group.children.forEach((child) => (child.position.z = PROJECTILE_HEIGHT));
    // Shared resources: nothing to dispose per projectile.
    return { object: group, dispose: () => {} };
  }

  createPickupView(pickup: Pickup): EntityView<PickupViewState> {
    const group = new THREE.Group();
    const color = WEAPON_COLORS[pickup.weapon];
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }),
    );
    glow.position.z = 0.02;
    const crate = box(0.3, 0.3, 0.3, color);
    const crateMaterial = crate.material as THREE.MeshLambertMaterial;
    crateMaterial.transparent = true;
    group.add(glow, crate);
    let time = Math.random() * 10;
    return {
      object: group,
      update: (dt, { usable }) => {
        // Disabled (e.g. you're "it" in tag): grey, see-through, resting on the ground, no glow.
        glow.visible = usable;
        crateMaterial.color.setHex(usable ? color : 0x6b6b6b);
        crateMaterial.opacity = usable ? 1 : 0.45;
        if (!usable) {
          crate.position.z = 0.15;
          return;
        }
        time += dt;
        crate.rotation.z = time * 2;
        crate.position.z = 0.35 + Math.sin(time * 3) * 0.06;
      },
      dispose: () => disposeObject(group),
    };
  }

  createEffectView(event: GameEvent): EffectView | null {
    // Deaths are shown by the ped view (body, blood); other events have no effect of their own.
    if (event.type !== 'impact' && event.type !== 'explosion') return null;
    const explosion = event.type === 'explosion';
    const duration = explosion ? 0.6 : 0.15;
    const startSize = explosion ? 0.3 : 0.08;
    const endSize = explosion ? event.radius : 0.22;
    const material = new THREE.MeshBasicMaterial({ color: explosion ? 0xff7a1a : 0xfff2a8, transparent: true });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), material);
    mesh.position.z = explosion ? 0.3 : PROJECTILE_HEIGHT;
    const group = new THREE.Group();
    group.add(mesh);
    let age = 0;
    return {
      object: group,
      update: (dt) => {
        age += dt;
        const t = Math.min(age / duration, 1);
        const eased = 1 - (1 - t) * (1 - t);
        mesh.scale.setScalar(startSize + (endSize - startSize) * eased);
        material.opacity = 1 - t;
        if (explosion) material.color.setHSL(0.08 - t * 0.06, 1, 0.55 - t * 0.3);
        return t < 1;
      },
      dispose: () => disposeObject(group),
    };
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

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Block, CAR_MODELS, type BlockMap, type Car, type CarModelId, type Ped, type Pickup, type WeaponId } from '@game/shared';
import type { AssetPack, EntityView, PickupViewState } from '../AssetPack';
import { BloodPool, CarDamageEffects, carDamage, hash } from '../common';
import { PlaceholderPack, hasDash } from '../placeholder/PlaceholderPack';

const BASE = `${import.meta.env.BASE_URL}assets/kenney/`;

/** Which Car Kit models stand in for each of our car types; each car picks one by its id. */
const CAR_VARIANTS: Record<CarModelId, string[]> = {
  compact: ['hatchback-sports'],
  sedan: ['sedan', 'taxi', 'police', 'suv'],
  sports: ['sedan-sports', 'race'],
  truck: ['truck', 'delivery', 'garbage-truck'],
};

const CHARACTERS = ['manBlue', 'hitman1', 'womanGreen', 'soldier1', 'survivor1', 'manBrown', 'robot1', 'manOld'];
type Pose = 'stand' | 'gun' | 'machine' | 'silencer';
const POSES: Pose[] = ['stand', 'gun', 'machine', 'silencer'];
const POSE_FOR_WEAPON: Record<WeaponId, Pose> = { pistol: 'gun', machineGun: 'machine', rocketLauncher: 'silencer' };
const WEAPON_ICONS: Record<WeaponId, string> = { pistol: 'weapon_gun', machineGun: 'weapon_machine', rocketLauncher: 'weapon_silencer' };
const WEAPON_COLORS: Record<WeaponId, number> = { pistol: 0xd7dde0, machineGun: 0x42a5f5, rocketLauncher: 0xef5350 };

/** Top-down Shooter sprites: pixels per block, and where the body's centre is from the left edge. */
const SPRITE_SCALE = 1 / 92;
const BODY_CENTER_PX = 16.5;

/** Ground tiles by block kind. */
const GROUND_TILES: Partial<Record<number, string>> = {
  [Block.Road]: 'tile_86',
  [Block.Pavement]: 'tile_08',
  [Block.Grass]: 'tile_01',
  [Block.Water]: 'tile_19',
};
const BUSHES = ['tile_183', 'tile_186', 'tile_235'];

/** Pastel building colours, multiplied with the white facade texture. */
const BUILDING_COLORS = [0xe8d8c4, 0xc9d6df, 0xf0c987, 0xd9a7a0, 0xb4cfae, 0xc3b8e0];

/** Car Kit models are Y-up with the front towards +Z and the left side at +X; our world is Z-up, front +X, left +Y. */
const MODEL_TO_WORLD = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);

interface CarTemplate {
  /** The model turned into our axes, centred, with its wheels on z = 0. */
  object: THREE.Object3D;
  size: THREE.Vector3;
}

/**
 * The default look: free CC0 art by Kenney (kenney.nl). 3D cars from the Car Kit; people, ground
 * tiles, crates and bushes from Top-down Shooter; buildings with facades drawn in code. Bullets,
 * explosions and other effects are shared with the placeholder pack.
 */
export class KenneyPack extends PlaceholderPack implements AssetPack {
  override readonly id = 'kenney';
  override readonly name = 'Kenney (CC0)';

  private readonly textures = new Map<string, THREE.Texture>();
  private readonly cars = new Map<string, CarTemplate>();
  private facade!: THREE.Texture;
  private roof!: THREE.Texture;
  private readonly spriteGeometry = new THREE.PlaneGeometry(1, 1);

  override async load(): Promise<void> {
    const textureLoader = new THREE.TextureLoader();
    const loadTexture = async (name: string) => {
      const texture = await textureLoader.loadAsync(`${BASE}${name}.png`);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      this.textures.set(name, texture);
    };
    const gltf = new GLTFLoader();
    const loadCar = async (file: string) => {
      const scene = (await gltf.loadAsync(`${BASE}cars/${file}.glb`)).scene;
      const object = new THREE.Group();
      scene.applyMatrix4(MODEL_TO_WORLD);
      object.add(scene);
      const bounds = new THREE.Box3().setFromObject(object);
      const center = bounds.getCenter(new THREE.Vector3());
      scene.position.sub(new THREE.Vector3(center.x, center.y, bounds.min.z));
      this.cars.set(file, { object, size: bounds.getSize(new THREE.Vector3()) });
    };

    const people = CHARACTERS.flatMap((c) => POSES.map((p) => `people/${c}_${p}`));
    const tiles = [...Object.values(GROUND_TILES), ...BUSHES, 'tile_129', ...Object.values(WEAPON_ICONS)].map((t) => `tiles/${t}`);
    await Promise.all([...people, ...tiles].map(loadTexture));
    await Promise.all([...new Set(Object.values(CAR_VARIANTS).flat())].map(loadCar));
    this.facade = canvasTexture(64, drawFacade);
    this.roof = canvasTexture(64, drawRoof);
  }

  override buildMap(map: BlockMap): THREE.Object3D {
    const group = new THREE.Group();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 0, 1);
    const color = new THREE.Color();
    const cellsOf = (test: (i: number) => boolean) => [...map.kinds.keys()].filter(test);
    const xy = (cell: number) => [cell % map.width, Math.floor(cell / map.width)] as const;

    // Ground: one instanced mesh per tile, each cell turned a random quarter to hide repetition.
    for (const [kind, tile] of Object.entries(GROUND_TILES)) {
      const cells = cellsOf((i) => map.kinds[i] === Number(kind));
      const mesh = new THREE.InstancedMesh(this.spriteGeometry, new THREE.MeshLambertMaterial({ map: this.texture(`tiles/${tile}`) }), cells.length);
      cells.forEach((cell, n) => {
        const [x, y] = xy(cell);
        rotation.setFromAxisAngle(up, Math.floor(hash(x, y) * 4) * (Math.PI / 2));
        mesh.setMatrixAt(n, matrix.compose(position.set(x + 0.5, y + 0.5, 0), rotation, scale));
      });
      group.add(mesh);
    }
    rotation.identity();

    // Dashed white centre lines on marked roads.
    const dashes = cellsOf((i) => hasDash(map, i));
    const dashMesh = new THREE.InstancedMesh(this.spriteGeometry, new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }), dashes.length);
    dashes.forEach((cell, n) => {
      const [x, y] = xy(cell);
      const horizontal = map.variants[cell] === 1;
      dashMesh.setMatrixAt(n, matrix.compose(position.set(x + 0.5, y + 0.5, 0.01), rotation, new THREE.Vector3(horizontal ? 0.5 : 0.07, horizontal ? 0.07 : 0.5, 1)));
    });
    group.add(dashMesh);

    // Bushes scattered over grass (decoration only; you can walk through them).
    const bushMeshes = BUSHES.map((name) => new THREE.InstancedMesh(this.spriteGeometry, spriteMaterial(this.texture(`tiles/${name}`)), map.kinds.length));
    const bushCounts = BUSHES.map(() => 0);
    for (const cell of cellsOf((i) => map.kinds[i] === Block.Grass)) {
      const [x, y] = xy(cell);
      const roll = hash(y * 7 + 3, x * 13 + 1);
      if (roll > 0.35) continue;
      const kind = Math.floor(roll * 20) % BUSHES.length;
      const size = 0.55 + hash(x + 11, y + 5) * 0.35;
      rotation.setFromAxisAngle(up, hash(x, y + 9) * Math.PI * 2);
      bushMeshes[kind]!.setMatrixAt(
        bushCounts[kind]!++,
        matrix.compose(position.set(x + 0.2 + hash(x + 3, y) * 0.6, y + 0.2 + hash(x, y + 3) * 0.6, 0.03), rotation, new THREE.Vector3(size, size, 1)),
      );
    }
    bushMeshes.forEach((mesh, i) => {
      mesh.count = bushCounts[i]!;
      group.add(mesh);
    });
    rotation.identity();

    // Buildings: a stack of one-block cubes per cell, so every storey gets its own row of windows.
    const buildingCells = cellsOf((i) => map.kinds[i] === Block.Building);
    const storeys = buildingCells.reduce((sum, cell) => sum + Math.max(1, map.levels[cell]!), 0);
    const wall = new THREE.MeshLambertMaterial({ map: this.facade });
    const roof = new THREE.MeshLambertMaterial({ map: this.roof });
    // BoxGeometry faces: +x, -x, +y, -y, +z (roof), -z.
    const buildings = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), [wall, wall, wall, wall, roof, wall], storeys);
    let n = 0;
    for (const cell of buildingCells) {
      const [x, y] = xy(cell);
      color.setHex(BUILDING_COLORS[map.variants[cell]! % BUILDING_COLORS.length]!);
      for (let level = 0; level < Math.max(1, map.levels[cell]!); level++) {
        buildings.setMatrixAt(n, matrix.makeTranslation(x + 0.5, y + 0.5, level + 0.5));
        buildings.setColorAt(n++, color);
      }
    }
    group.add(buildings);
    return group;
  }

  override createCarView(car: Car): EntityView<Car> {
    const m = CAR_MODELS[car.model];
    const variants = CAR_VARIANTS[car.model];
    const template = this.cars.get(variants[car.id % variants.length]!)!;
    const group = new THREE.Group();

    // Stretch the model to our car's exact footprint; height follows the width.
    const body = template.object.clone(true);
    const widthScale = m.width / template.size.y;
    body.scale.set(m.length / template.size.x, widthScale, widthScale);
    // Own materials, so damage can darken this car only (geometry stays shared).
    const materials: THREE.MeshStandardMaterial[] = [];
    body.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.material = (obj.material as THREE.MeshStandardMaterial).clone();
        materials.push(obj.material);
      }
    });
    group.add(body);

    const effects = new CarDamageEffects(m, template.size.z * widthScale + 0.1);
    group.add(effects.object);
    const white = new THREE.Color(0xffffff);
    const burnt = new THREE.Color(0x1c1c1c);
    return {
      object: group,
      update: (dt, state) => {
        const damage = carDamage(state);
        for (const material of materials) material.color.copy(white).lerp(burnt, state.wrecked ? 0.85 : damage * 0.55);
        effects.update(dt, state);
      },
      dispose: () => {
        materials.forEach((material) => material.dispose());
        effects.object.traverse((obj) => obj instanceof THREE.Mesh && (obj.geometry.dispose(), (obj.material as THREE.Material).dispose()));
      },
    };
  }

  override createPedView(ped: Ped): EntityView<Ped> {
    const group = new THREE.Group();
    const character = CHARACTERS[ped.id % CHARACTERS.length]!;
    const material = spriteMaterial(this.texture(`people/${character}_stand`));
    const sprite = new THREE.Mesh(this.spriteGeometry, material);
    sprite.position.z = 0.3;

    // A ring in the player's colour, so you can tell who's who (and match their arrow).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.28, 24),
      new THREE.MeshBasicMaterial({ color: ped.color, transparent: true, opacity: 0.8 }),
    );
    ring.position.z = 0.02;
    const blood = new BloodPool();
    group.add(blood.object, ring, sprite);

    let pose: Pose | null = null;
    return {
      object: group,
      update: (dt, state) => {
        const dead = state.respawnAt !== null;
        const next: Pose = dead || state.weapon === null ? 'stand' : POSE_FOR_WEAPON[state.weapon];
        if (next !== pose) {
          pose = next;
          const texture = this.texture(`people/${character}_${pose}`);
          material.map = texture;
          const image = texture.image as { width: number; height: number };
          sprite.scale.set(image.width * SPRITE_SCALE, image.height * SPRITE_SCALE, 1);
          // Sprites face +x with the gun sticking out in front: keep the body centred on the ped.
          sprite.position.x = (image.width / 2 - BODY_CENTER_PX) * SPRITE_SCALE;
        }
        // Dead: lying on the side, darkened, in a pool of blood.
        sprite.rotation.z = dead ? Math.PI / 2 : 0;
        material.color.setHex(dead ? 0x707070 : 0xffffff);
        ring.visible = !dead;
        blood.update(dt, dead);
      },
      dispose: () => {
        material.dispose();
        ring.geometry.dispose();
        (ring.material as THREE.Material).dispose();
        blood.object.geometry.dispose();
        (blood.object.material as THREE.Material).dispose();
      },
    };
  }

  override createPickupView(pickup: Pickup): EntityView<PickupViewState> {
    const group = new THREE.Group();
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.34, 24),
      new THREE.MeshBasicMaterial({ color: WEAPON_COLORS[pickup.weapon], transparent: true, opacity: 0.45 }),
    );
    glow.position.z = 0.02;
    const crateMaterial = spriteMaterial(this.texture('tiles/tile_129'));
    const crate = new THREE.Mesh(this.spriteGeometry, crateMaterial);
    crate.scale.set(0.55, 0.55, 1);
    const iconTexture = this.texture(`tiles/${WEAPON_ICONS[pickup.weapon]}`);
    const iconMaterial = spriteMaterial(iconTexture);
    const icon = new THREE.Mesh(this.spriteGeometry, iconMaterial);
    const image = iconTexture.image as { width: number; height: number };
    icon.scale.set(image.width / 70, image.height / 70, 1);
    const spinner = new THREE.Group();
    spinner.add(crate, icon);
    crate.position.z = 0.3;
    icon.position.z = 0.31;
    group.add(glow, spinner);

    let time = Math.random() * 10;
    return {
      object: group,
      update: (dt, { usable }) => {
        // Disabled (e.g. you're "it" in tag): grey, see-through, still, no glow.
        glow.visible = usable;
        crateMaterial.color.setHex(usable ? 0xffffff : 0x8a8a8a);
        crateMaterial.opacity = iconMaterial.opacity = usable ? 1 : 0.4;
        if (!usable) return;
        time += dt;
        spinner.rotation.z = Math.sin(time * 1.5) * 0.4;
        const pulse = 1 + Math.sin(time * 3) * 0.06;
        spinner.scale.set(pulse, pulse, 1);
      },
      dispose: () => {
        crateMaterial.dispose();
        iconMaterial.dispose();
        glow.geometry.dispose();
        (glow.material as THREE.Material).dispose();
      },
    };
  }

  private texture(name: string): THREE.Texture {
    const texture = this.textures.get(name);
    if (!texture) throw new Error(`Kenney pack: texture ${name} was not loaded`);
    return texture;
  }
}

function spriteMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.05, depthWrite: false });
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** One storey of wall: white (tinted per building) with two framed windows. */
function drawFacade(g: CanvasRenderingContext2D, s: number): void {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#e6e6e6';
  g.fillRect(0, s - 6, s, 6); // floor line
  for (const x of [8, 36]) {
    g.fillStyle = '#5b6470';
    g.fillRect(x - 2, 14, 24, 32);
    g.fillStyle = '#2f3b4a';
    g.fillRect(x, 16, 20, 28);
    g.fillStyle = 'rgba(255, 255, 255, 0.25)';
    g.fillRect(x + 2, 18, 6, 24); // reflection
  }
}

/**
 * A flat roof, seamless so neighbouring roof cells read as one roof: light grey with a faint
 * speckle (fixed pattern, so every client draws the same).
 */
function drawRoof(g: CanvasRenderingContext2D, s: number): void {
  g.fillStyle = '#d4d4d4';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 90; i++) {
    const x = (i * 37) % s;
    const y = (i * 53 + (i >> 3) * 11) % s;
    g.fillStyle = i % 3 === 0 ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.35)';
    g.fillRect(x, y, 2, 2);
  }
}

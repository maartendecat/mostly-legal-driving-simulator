import * as THREE from 'three';
import {
  canPickUpWeapons,
  carSpeed,
  isBusted,
  isPickupAvailable,
  type BlockMap,
  type Car,
  type GameEvent,
  type Ped,
  type Projectile,
  type World,
} from '@game/shared';
import type { AssetPack, EffectView, EntityView, PickupViewState } from '../assets/AssetPack';
import type { Transform, TransformSnapshot } from './transforms';

/** Field of view in degrees across the shorter side of the window. */
const FIELD_OF_VIEW = 60;
/** Camera height on foot; it rises with speed like GTA2's zoom-out when driving fast. */
const BASE_CAMERA_HEIGHT = 11;
const SPEED_ZOOM = 0.8;
const MAX_CAMERA_HEIGHT = 26;
/** How far ahead of a moving car the camera looks, in seconds of travel. */
const LOOKAHEAD_TIME = 0.35;

/**
 * Draws the world top-down in 3D. A perspective camera looking straight down gives GTA2's
 * characteristic parallax on building walls.
 */
export class GameRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 200);
  private readonly carViews = new Map<number, EntityView<Car>>();
  private readonly pedViews = new Map<number, EntityView<Ped>>();
  private readonly projectileViews = new Map<number, EntityView<Projectile>>();
  private readonly pickupViews = new Map<number, EntityView<PickupViewState>>();
  private readonly effects = new Set<EffectView>();
  private mapObject: THREE.Object3D | null = null;
  private cameraHeight = BASE_CAMERA_HEIGHT;
  private readonly lookahead = new THREE.Vector2();
  private readonly projected = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    private readonly pack: AssetPack,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.4, -0.7, 1); // light from the south-east so walls shade differently
    this.scene.add(sun);

    // Default camera orientation already looks down -z with +y up the screen.
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setMap(map: BlockMap): void {
    if (this.mapObject) this.scene.remove(this.mapObject);
    this.mapObject = this.pack.buildMap(map);
    this.scene.add(this.mapObject);
  }

  /**
   * @param transforms where to draw each entity this frame (already interpolated)
   * @param focusPedId the ped the camera follows
   * @param events events to show as effects, starting this frame
   */
  render(world: World, transforms: TransformSnapshot, focusPedId: number | null, frameDt: number, events: readonly GameEvent[] = []): void {
    this.syncViews(this.carViews, world.cars, (car) => this.pack.createCarView(car));
    this.syncViews(this.pedViews, world.peds, (ped) => this.pack.createPedView(ped));
    this.syncViews(this.projectileViews, world.projectiles, (p) => this.pack.createProjectileView(p));
    this.syncViews(this.pickupViews, world.pickups, (p) => this.pack.createPickupView(p));

    for (const car of world.cars.values()) this.place(this.carViews.get(car.id)!, car, transforms.get(car.id) ?? car, frameDt);
    for (const ped of world.peds.values()) {
      const view = this.pedViews.get(ped.id)!;
      // Not drawn: sitting in a car, or arrested and taken away.
      view.object.visible = ped.carId === null && !isBusted(ped);
      this.place(view, ped, transforms.get(ped.id) ?? ped, frameDt);
    }
    for (const p of world.projectiles.values()) this.place(this.projectileViews.get(p.id)!, p, transforms.get(p.id) ?? p, frameDt);
    const me = focusPedId === null ? undefined : world.peds.get(focusPedId);
    const weaponsUsable = !me || canPickUpWeapons(world, me);
    // Cop bribes only do anything for you while the police are after you.
    const bribesUsable = !me || me.wanted > 0;
    for (const pickup of world.pickups.values()) {
      const view = this.pickupViews.get(pickup.id)!;
      view.object.visible = isPickupAvailable(world, pickup);
      const usable = pickup.kind === 'bribe' ? bribesUsable : weaponsUsable;
      this.place(view, { pickup, usable }, { x: pickup.x, y: pickup.y, heading: 0 }, frameDt);
    }
    this.updateEffects(events, frameDt);

    this.updateCamera(world, focusPedId, frameDt);
    this.renderer.render(this.scene, this.camera);
  }

  viewportSize(): { width: number; height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  /** Projects a world position to CSS pixels in the game container, or null if it's off screen. */
  projectToScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    const p = this.projected.set(x, y, z).project(this.camera);
    if (p.x < -1.1 || p.x > 1.1 || p.y < -1.1 || p.y > 1.1 || p.z > 1) return null;
    return {
      x: ((p.x + 1) / 2) * this.container.clientWidth,
      y: ((1 - p.y) / 2) * this.container.clientHeight,
    };
  }

  private place<T>(view: EntityView<T>, state: T, transform: Transform, frameDt: number): void {
    view.object.position.set(transform.x, transform.y, 0);
    view.object.rotation.z = transform.heading;
    view.update?.(frameDt, state);
  }

  private updateEffects(events: readonly GameEvent[], frameDt: number): void {
    for (const event of events) {
      const effect = this.pack.createEffectView(event);
      if (!effect) continue;
      effect.object.position.set(event.x, event.y, 0);
      this.effects.add(effect);
      this.scene.add(effect.object);
    }
    for (const effect of this.effects) {
      if (effect.update(frameDt)) continue;
      this.scene.remove(effect.object);
      effect.dispose();
      this.effects.delete(effect);
    }
  }

  private updateCamera(world: World, focusPedId: number | null, frameDt: number): void {
    const ped = focusPedId === null ? undefined : world.peds.get(focusPedId);
    if (!ped) return;
    const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
    const target = car ? this.carViews.get(car.id)! : this.pedViews.get(ped.id)!;
    const speed = car ? carSpeed(car) : 0;

    const smoothing = 1 - Math.exp(-3 * frameDt);
    const targetHeight = Math.min(BASE_CAMERA_HEIGHT + speed * SPEED_ZOOM, MAX_CAMERA_HEIGHT);
    this.cameraHeight += (targetHeight - this.cameraHeight) * smoothing;
    this.lookahead.x += ((car ? car.vx * LOOKAHEAD_TIME : 0) - this.lookahead.x) * smoothing;
    this.lookahead.y += ((car ? car.vy * LOOKAHEAD_TIME : 0) - this.lookahead.y) * smoothing;

    const pos = target.object.position;
    this.camera.position.set(pos.x + this.lookahead.x, pos.y + this.lookahead.y, this.cameraHeight);
  }

  private syncViews<T extends { id: number }, S>(views: Map<number, EntityView<S>>, entities: Map<number, T>, create: (entity: T) => EntityView<S>): void {
    for (const [id, view] of views) {
      if (!entities.has(id)) {
        this.scene.remove(view.object);
        view.dispose();
        views.delete(id);
      }
    }
    for (const entity of entities.values()) {
      if (views.has(entity.id)) continue;
      const view = create(entity);
      views.set(entity.id, view);
      this.scene.add(view.object);
    }
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.container;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    // Keep the field of view on the shorter side, so portrait windows don't see less of the city.
    const shortSideFov = THREE.MathUtils.degToRad(FIELD_OF_VIEW);
    this.camera.fov = this.camera.aspect >= 1 ? FIELD_OF_VIEW : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(shortSideFov / 2) / this.camera.aspect));
    this.camera.updateProjectionMatrix();
  }
}

/**
 * Gameplay stats for a car model. Visuals live in asset packs, keyed by `id`, so the server can
 * simulate cars without loading any graphics. Distances are in blocks, times in seconds.
 */
export interface CarModel {
  id: string;
  name: string;
  length: number;
  width: number;
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  /** Turn rate in rad/s once the car is moving fast enough to steer fully. */
  turnRate: number;
  /** How quickly sideways sliding is cancelled; lower values drift more. */
  grip: number;
  handbrakeGrip: number;
  health: number;
  /** Relative weight in collisions (a sedan is 1): heavier cars push lighter ones and get hurt less. */
  mass: number;
  /** The share of bullet damage that gets through (1: none stopped). Explosions always do full damage. */
  armour: number;
}

export const CAR_MODELS = {
  compact: {
    id: 'compact', name: 'Compact', length: 1.0, width: 0.5,
    maxSpeed: 11, reverseSpeed: 4, accel: 9, brake: 18, turnRate: 3.2, grip: 8, handbrakeGrip: 1.2, health: 80, mass: 0.8, armour: 1,
  },
  sedan: {
    id: 'sedan', name: 'Sedan', length: 1.15, width: 0.55,
    maxSpeed: 13, reverseSpeed: 4, accel: 8, brake: 18, turnRate: 2.8, grip: 7, handbrakeGrip: 1.0, health: 100, mass: 1, armour: 1,
  },
  sports: {
    id: 'sports', name: 'Sports car', length: 1.1, width: 0.55,
    maxSpeed: 18, reverseSpeed: 5, accel: 13, brake: 22, turnRate: 3.0, grip: 9, handbrakeGrip: 1.4, health: 90, mass: 1, armour: 1,
  },
  truck: {
    id: 'truck', name: 'Truck', length: 1.6, width: 0.65,
    maxSpeed: 9, reverseSpeed: 3, accel: 5, brake: 12, turnRate: 2.0, grip: 10, handbrakeGrip: 2.0, health: 180, mass: 2, armour: 1,
  },
  /** Only the fire brigade drives these (see fire.ts); they never appear parked or in traffic. */
  fireTruck: {
    id: 'fireTruck', name: 'Fire truck', length: 1.8, width: 0.7,
    maxSpeed: 10, reverseSpeed: 3, accel: 5, brake: 12, turnRate: 2.0, grip: 10, handbrakeGrip: 2.0, health: 220, mass: 2.5, armour: 1,
  },
  /** The police's SWAT van (see police.ts): heavy and bullet-resistant. */
  swatVan: {
    id: 'swatVan', name: 'SWAT van', length: 1.5, width: 0.68,
    maxSpeed: 11, reverseSpeed: 4, accel: 6, brake: 14, turnRate: 2.2, grip: 9, handbrakeGrip: 1.6, health: 350, mass: 2.5, armour: 0.3,
  },
  /** The army's troop truck. */
  armyTruck: {
    id: 'armyTruck', name: 'Army truck', length: 1.7, width: 0.72,
    maxSpeed: 9, reverseSpeed: 3, accel: 4.5, brake: 12, turnRate: 1.9, grip: 10, handbrakeGrip: 2.0, health: 300, mass: 3, armour: 0.5,
  },
  /**
   * The army's tank: slow, very heavy (it pushes anything aside and crushes cars it drives into),
   * nearly bulletproof, with a turret that turns on its own and fires shells (see army.ts).
   */
  tank: {
    id: 'tank', name: 'Tank', length: 1.6, width: 0.95,
    maxSpeed: 5, reverseSpeed: 3, accel: 3, brake: 10, turnRate: 1.3, grip: 14, handbrakeGrip: 6, health: 1000, mass: 12, armour: 0.1,
  },
} as const satisfies Record<string, CarModel>;

export type CarModelId = keyof typeof CAR_MODELS;

export const CAR_MODEL_IDS = Object.keys(CAR_MODELS) as CarModelId[];

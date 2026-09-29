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
}

export const CAR_MODELS = {
  compact: {
    id: 'compact', name: 'Compact', length: 1.0, width: 0.5,
    maxSpeed: 11, reverseSpeed: 4, accel: 9, brake: 18, turnRate: 3.2, grip: 8, handbrakeGrip: 1.2,
  },
  sedan: {
    id: 'sedan', name: 'Sedan', length: 1.15, width: 0.55,
    maxSpeed: 13, reverseSpeed: 4, accel: 8, brake: 18, turnRate: 2.8, grip: 7, handbrakeGrip: 1.0,
  },
  sports: {
    id: 'sports', name: 'Sports car', length: 1.1, width: 0.55,
    maxSpeed: 18, reverseSpeed: 5, accel: 13, brake: 22, turnRate: 3.0, grip: 9, handbrakeGrip: 1.4,
  },
  truck: {
    id: 'truck', name: 'Truck', length: 1.6, width: 0.65,
    maxSpeed: 9, reverseSpeed: 3, accel: 5, brake: 12, turnRate: 2.0, grip: 10, handbrakeGrip: 2.0,
  },
} as const satisfies Record<string, CarModel>;

export type CarModelId = keyof typeof CAR_MODELS;

export const CAR_MODEL_IDS = Object.keys(CAR_MODELS) as CarModelId[];

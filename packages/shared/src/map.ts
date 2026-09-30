import type { Vec2 } from './math';
import type { WeaponId } from './weapons';

/** What a map cell is made of. Gameplay only cares about the kind; asset packs decide how it looks. */
export const Block = {
  Road: 0,
  Pavement: 1,
  Grass: 2,
  Building: 3,
  Water: 4,
} as const;
export type BlockKind = (typeof Block)[keyof typeof Block];

/** Road variants that asset packs use to draw lane markings. */
export const RoadMarking = {
  None: 0,
  CenterHorizontal: 1,
  CenterVertical: 2,
} as const;

export interface CarSpawn {
  x: number;
  y: number;
  heading: number;
}

export interface PickupSpawn {
  x: number;
  y: number;
  weapon: WeaponId;
}

/**
 * A city map: a grid of 1x1 unit blocks. +x is east, +y is north.
 * Buildings have a height in levels (1 level = 1 unit). `variants` is free-form per-cell style
 * data (building colour/texture, road markings, ...) that only asset packs interpret.
 */
export interface BlockMap {
  width: number;
  height: number;
  kinds: Uint8Array;
  levels: Uint8Array;
  variants: Uint8Array;
  pedSpawns: Vec2[];
  carSpawns: CarSpawn[];
  pickupSpawns: PickupSpawn[];
}

export function createMap(width: number, height: number): BlockMap {
  const size = width * height;
  return {
    width,
    height,
    kinds: new Uint8Array(size),
    levels: new Uint8Array(size),
    variants: new Uint8Array(size),
    pedSpawns: [],
    carSpawns: [],
    pickupSpawns: [],
  };
}

export function inBounds(map: BlockMap, cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < map.width && cy < map.height;
}

export function setCell(map: BlockMap, cx: number, cy: number, kind: BlockKind, level = 0, variant = 0): void {
  const i = cy * map.width + cx;
  map.kinds[i] = kind;
  map.levels[i] = level;
  map.variants[i] = variant;
}

/** Cells outside the map count as buildings, so nothing can leave the city. */
export function kindAt(map: BlockMap, cx: number, cy: number): BlockKind {
  if (!inBounds(map, cx, cy)) return Block.Building;
  return map.kinds[cy * map.width + cx] as BlockKind;
}

export function isSolidCell(map: BlockMap, cx: number, cy: number): boolean {
  const kind = kindAt(map, cx, cy);
  return kind === Block.Building || kind === Block.Water;
}

export function isSolidAt(map: BlockMap, x: number, y: number): boolean {
  return isSolidCell(map, Math.floor(x), Math.floor(y));
}

import type { Snapshot } from './protocol';

/**
 * Delta snapshots: after one full snapshot, the server only sends what changed since the previous
 * one it sent. WebSocket delivery is reliable and in order, so the client always holds exactly the
 * snapshot a delta was made against and no acknowledgements are needed.
 *
 * Numbers are rounded before sending (see `quantizeSnapshot`); the server keeps simulating at full
 * precision, and the rounding is far below anything visible.
 */

type Entity = { id: number };
type EntityKey = 'cars' | 'peds' | 'projectiles' | 'pickups';
const ENTITY_KEYS: EntityKey[] = ['cars', 'peds', 'projectiles', 'pickups'];

/** Entities that are new (all fields) or changed (only the changed fields), and ids that are gone. */
export interface EntityDelta {
  set?: Record<string, unknown>[];
  remove?: number[];
}

export interface SnapshotDelta {
  tick: number;
  nextId: number;
  rngState: number;
  itPedId: number | null;
  cars: EntityDelta;
  peds: EntityDelta;
  projectiles: EntityDelta;
  pickups: EntityDelta;
}

/** Decimal places kept for fractional numbers (positions, velocities, headings). */
const PRECISION = 1e4;

/** A deep copy of the snapshot with every fractional number rounded, ready to send. */
export function quantizeSnapshot(snapshot: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(snapshot, (_, value: unknown) =>
    typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * PRECISION) / PRECISION : value,
  )) as Snapshot;
}

/** What changed from `previous` to `next` (both as sent, i.e. quantized). */
export function encodeDelta(previous: Snapshot, next: Snapshot): SnapshotDelta {
  const delta: SnapshotDelta = {
    tick: next.tick,
    nextId: next.nextId,
    rngState: next.rngState,
    itPedId: next.itPedId,
    cars: {},
    peds: {},
    projectiles: {},
    pickups: {},
  };
  for (const key of ENTITY_KEYS) delta[key] = diffEntities(previous[key] as Entity[], next[key] as Entity[]);
  return delta;
}

/** Rebuilds the next full snapshot from the previous one and a delta. Doesn't modify `previous`. */
export function applyDelta(previous: Snapshot, delta: SnapshotDelta): Snapshot {
  const next: Snapshot = { ...previous, tick: delta.tick, nextId: delta.nextId, rngState: delta.rngState, itPedId: delta.itPedId };
  for (const key of ENTITY_KEYS) (next[key] as Entity[]) = patchEntities(previous[key] as Entity[], delta[key]);
  return next;
}

function diffEntities(previous: Entity[], next: Entity[]): EntityDelta {
  const before = new Map(previous.map((e) => [e.id, e as unknown as Record<string, unknown>]));
  const set: Record<string, unknown>[] = [];
  for (const entity of next as unknown as Record<string, unknown>[]) {
    const old = before.get(entity.id as number);
    before.delete(entity.id as number);
    if (!old) {
      set.push(entity);
      continue;
    }
    const changed: Record<string, unknown> = { id: entity.id };
    let any = false;
    for (const [field, value] of Object.entries(entity)) {
      if (!sameValue(old[field], value)) {
        changed[field] = value;
        any = true;
      }
    }
    if (any) set.push(changed);
  }
  const delta: EntityDelta = {};
  if (set.length > 0) delta.set = set;
  if (before.size > 0) delta.remove = [...before.keys()];
  return delta;
}

function patchEntities(previous: Entity[], delta: EntityDelta): Entity[] {
  const removed = new Set(delta.remove ?? []);
  const changes = new Map((delta.set ?? []).map((change) => [change.id as number, change]));
  const result: Entity[] = [];
  for (const entity of previous) {
    if (removed.has(entity.id)) continue;
    const change = changes.get(entity.id);
    changes.delete(entity.id);
    // Changed entities are new objects; unchanged ones are shared with the previous snapshot.
    result.push(change ? ({ ...entity, ...change } as Entity) : entity);
  }
  for (const added of changes.values()) result.push(added as unknown as Entity);
  return result;
}

/** Field values are numbers, strings, booleans, null or small plain objects (a ped's ammo). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

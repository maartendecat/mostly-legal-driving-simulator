import { applyDelta, type ServerMessage } from '@game/shared';

type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
const lastSnapshot = new WeakMap<object, SnapshotMessage>();

/**
 * Test helper: turns the server's delta messages back into full snapshots (as the real client
 * does), so tests can keep reading complete snapshots. `owner` is the test client.
 */
export function asFullSnapshots(owner: object, message: ServerMessage): ServerMessage[] {
  if (message.type === 'snapshot') {
    lastSnapshot.set(owner, message);
    return [message];
  }
  if (message.type !== 'delta') return [message];
  const previous = lastSnapshot.get(owner);
  if (!previous) throw new Error('delta before any full snapshot');
  const full: SnapshotMessage = {
    ...previous,
    ...applyDelta(previous, message),
    type: 'snapshot',
    acks: message.acks,
    events: message.events,
    players: message.players ?? previous.players,
    match: message.match ?? previous.match,
  };
  lastSnapshot.set(owner, full);
  return [full];
}

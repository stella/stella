import { detached } from "@/lib/detached";

type SaveQueue = { inFlight: boolean; pending: string | null };

/**
 * Serializes writes per key: one request in flight, the newest value coalesced
 * behind it. Concurrent PATCHes of the same row can be applied out of order
 * server-side, silently persisting stale text even when the client discards the
 * stale response.
 */
export const createSerializedSaver = (
  write: (key: string, value: string) => Promise<void>,
) => {
  const queues = new Map<string, SaveQueue>();

  // Each write lands before the value queued behind it is sent; the chain
  // ends when nothing newer arrived while the last write was in flight.
  const drain = async (
    key: string,
    queue: SaveQueue,
    value: string,
  ): Promise<void> => {
    await write(key, value);
    const next = queue.pending;
    queue.pending = null;
    if (next === null) {
      queue.inFlight = false;
      return;
    }
    await drain(key, queue, next);
  };

  return (key: string, value: string): void => {
    const existing = queues.get(key);
    if (existing?.inFlight) {
      existing.pending = value;
      return;
    }
    const queue = existing ?? { inFlight: false, pending: null };
    queues.set(key, queue);
    queue.inFlight = true;
    detached(drain(key, queue, value), "skill-history.serialized-save");
  };
};

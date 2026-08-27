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

  const run = async (key: string, first: string) => {
    const queue = queues.get(key) ?? { inFlight: false, pending: null };
    queues.set(key, queue);
    queue.inFlight = true;
    let next: string | null = first;
    while (next !== null) {
      // oxlint-disable-next-line no-await-in-loop -- sequential save queue: each write must land before the newer value is sent
      await write(key, next);
      next = queue.pending;
      queue.pending = null;
    }
    queue.inFlight = false;
  };

  return (key: string, value: string): void => {
    const queue = queues.get(key);
    if (queue?.inFlight) {
      queue.pending = value;
      return;
    }
    detached(run(key, value), "skill-history.serialized-save");
  };
};

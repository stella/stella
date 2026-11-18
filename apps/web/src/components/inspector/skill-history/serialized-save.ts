import { detached } from "@/lib/detached";

type SaveQueue<TValue> = {
  inFlight: boolean;
  pending: { value: TValue } | null;
};

export type SerializedSaveContext<TValue> = {
  initialValue: TValue;
  hasPending: () => boolean;
};

/**
 * Serializes writes per key: one request in flight, the newest value coalesced
 * behind it. The first value remains the batch's context until the queue drains.
 * Concurrent PATCHes can otherwise persist stale text even when the client
 * discards the stale response.
 */
export const createSerializedSaver = <TKey extends string, TValue>(
  write: (
    key: TKey,
    value: TValue,
    context: SerializedSaveContext<TValue>,
  ) => Promise<void>,
) => {
  const queues = new Map<TKey, SaveQueue<TValue>>();

  type DrainInput = {
    key: TKey;
    queue: SaveQueue<TValue>;
    value: TValue;
    initialValue: TValue;
  };

  // A rejected write still hands the queue on, so the newest value is not stranded.
  const drain = async ({
    key,
    queue,
    value,
    initialValue,
  }: DrainInput): Promise<void> => {
    try {
      await write(key, value, {
        initialValue,
        hasPending: () => queue.pending !== null,
      });
    } finally {
      const next = queue.pending;
      queue.pending = null;
      if (next === null) {
        queue.inFlight = false;
      } else {
        detached(
          drain({ key, queue, value: next.value, initialValue }),
          "skill-history.serialized-save",
        );
      }
    }
  };

  return (key: TKey, value: TValue): void => {
    const existing = queues.get(key);
    if (existing?.inFlight) {
      existing.pending = { value };
      return;
    }
    const queue = existing ?? { inFlight: false, pending: null };
    queues.set(key, queue);
    queue.inFlight = true;
    detached(
      drain({ key, queue, value, initialValue: value }),
      "skill-history.serialized-save",
    );
  };
};

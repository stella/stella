import { Result } from "better-result";
import * as v from "valibot";

import { presentationPrefsSchema } from "./preferences";
import type { PresentationPrefs } from "./preferences";

export const PRESENTATION_PREFS_CHANNEL = "stella.presentation-prefs";
export const PRESENTATION_PREFS_LOCK = "stella.presentation-prefs.write";

const appliedPrefsSchema = v.strictObject({
  type: v.literal("applied"),
  prefs: presentationPrefsSchema,
});

type PrefsChannel = {
  postMessage: (message: unknown) => void;
  close: () => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
};

/** Evaluated optimistically, then again against the stored prefs under the write lock. */
export type PresentationPrefsUpdate = (
  latest: PresentationPrefs,
) => Partial<PresentationPrefs>;

const applyUpdate = (
  prefs: PresentationPrefs,
  update: PresentationPrefsUpdate,
): PresentationPrefs => ({ ...prefs, ...update(prefs) });

type PresentationPrefsSyncOptions = {
  initialPrefs: PresentationPrefs;
  read: () => Promise<PresentationPrefs>;
  write: (patch: Partial<PresentationPrefs>) => Promise<PresentationPrefs>;
  withLock?: (write: () => Promise<void>) => Promise<void>;
  openChannel?: () => PrefsChannel | undefined;
};

export const createPresentationPrefsSync = ({
  initialPrefs,
  read,
  write,
  withLock = async (operation) => await operation(),
  openChannel,
}: PresentationPrefsSyncOptions) => {
  let applied = initialPrefs;
  let snapshot = initialPrefs;
  let queued: Promise<unknown> = Promise.resolve();
  const pending: { patch: PresentationPrefsUpdate }[] = [];
  const listeners = new Set<() => void>();
  let channel: PrefsChannel | undefined;
  let peerSubscribers = 0;

  const refresh = () => {
    // A peer's committed snapshot must not erase this tab's pending edits.
    snapshot = applied;
    for (const { patch } of pending) {
      snapshot = applyUpdate(snapshot, patch);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  const onMessage = ({ data }: MessageEvent<unknown>) => {
    const message = v.safeParse(appliedPrefsSchema, data);
    if (!message.success) {
      return;
    }
    applied = message.output.prefs;
    refresh();
  };
  const connect = () => {
    if (channel === undefined) {
      channel = openChannel?.();
      channel?.addEventListener("message", onMessage);
    }
    return channel;
  };
  const disconnectIfUnused = () => {
    if (peerSubscribers > 0 || channel === undefined) {
      return;
    }
    channel.removeEventListener("message", onMessage);
    channel.close();
    channel = undefined;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeToPeers: () => {
      peerSubscribers += 1;
      connect();
      return () => {
        peerSubscribers -= 1;
        disconnectIfUnused();
      };
    },
    update: async (patch: PresentationPrefsUpdate) => {
      const update = { patch };
      pending.push(update);
      refresh();
      const save = queued
        .then(
          async () =>
            await withLock(async () => {
              // Start the request under the origin-wide lock: its Cookie header
              // must include the preceding response's Set-Cookie changes.
              const latest = await read();
              applied = await write(patch(latest));
              pending.splice(pending.indexOf(update), 1);
              refresh();
              const activeChannel = connect();
              if (activeChannel !== undefined) {
                const post = activeChannel.postMessage.bind(activeChannel);
                post({ type: "applied", prefs: applied });
              }
            }),
        )
        .finally(() => {
          const index = pending.indexOf(update);
          if (index !== -1) {
            pending.splice(index, 1);
            refresh();
          }
          disconnectIfUnused();
        });
      // A failed save still rejects its caller; encode that result only for
      // the queue tail so later changes can proceed after a failure.
      queued = Result.tryPromise({
        try: async () => await save,
        catch: (error) => error,
      });
      return save;
    },
  };
};

export type PresentationPrefsSync = ReturnType<
  typeof createPresentationPrefsSync
>;

import { Result } from "better-result";

import { defaultPresentationPrefs } from "./preferences";
import type { PresentationPrefs } from "./preferences";
import { createPresentationPrefsSync } from "./sync";

export const createTestPresentationPrefsSync = (
  initialPrefs = defaultPresentationPrefs,
  onSave: (patch: Partial<PresentationPrefs>) => void = () => undefined,
) => {
  let saved = initialPrefs;
  return createPresentationPrefsSync({
    initialPrefs,
    read: async () => await Promise.resolve(saved),
    write: async (patch) => {
      onSave(patch);
      saved = { ...saved, ...patch };
      return await Promise.resolve(saved);
    },
  });
};

export const createPrefsBroadcastHub = () => {
  const peers = new Set<(message: unknown) => void>();
  let deliveryEnabled = true;
  return {
    connected: () => peers.size,
    setDeliveryEnabled: (enabled: boolean) => {
      deliveryEnabled = enabled;
    },
    open: () => {
      const listeners = new Set<(event: MessageEvent<unknown>) => void>();
      const receive = (data: unknown) => {
        for (const listener of listeners) {
          listener(new MessageEvent("message", { data }));
        }
      };
      peers.add(receive);
      return {
        postMessage: (message: unknown) => {
          if (!deliveryEnabled) {
            return;
          }
          for (const peer of peers) {
            if (peer !== receive) {
              peer(message);
            }
          }
        },
        addEventListener: (
          _type: "message",
          listener: (event: MessageEvent<unknown>) => void,
        ) => {
          listeners.add(listener);
        },
        removeEventListener: (
          _type: "message",
          listener: (event: MessageEvent<unknown>) => void,
        ) => {
          listeners.delete(listener);
        },
        close: () => {
          peers.delete(receive);
        },
      };
    },
  };
};

export const createPrefsWriteLock = () => {
  let queue: Promise<unknown> = Promise.resolve();
  return async (write: () => Promise<void>) => {
    const result = queue.then(write);
    queue = Result.tryPromise({
      try: async () => await result,
      catch: (error) => error,
    });
    await result;
  };
};

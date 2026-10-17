import { createContext, use, useState, useSyncExternalStore } from "react";
import type { PropsWithChildren, RefObject } from "react";

import { Result } from "better-result";

import { getTranslator } from "@/i18n/translator";
import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { writePresentationPrefs } from "@/lib/account/presentation-prefs/server";
import {
  createPresentationPrefsSync,
  PRESENTATION_PREFS_CHANNEL,
  PRESENTATION_PREFS_LOCK,
} from "@/lib/account/presentation-prefs/sync";
import type { PresentationPrefsSync } from "@/lib/account/presentation-prefs/sync";
import { getAnalytics } from "@/lib/analytics/provider";
import { detachedUserAction } from "@/lib/errors/user-toast";

const createBrowserSync = (initialPrefs: PresentationPrefs) =>
  createPresentationPrefsSync({
    initialPrefs,
    write: async (patch) => await writePresentationPrefs({ data: patch }),
    withLock: async (write) => {
      if (navigator.locks !== undefined) {
        await navigator.locks.request(PRESENTATION_PREFS_LOCK, write);
        return;
      }
      await write();
    },
    openChannel: () => {
      if (typeof BroadcastChannel === "undefined") {
        return undefined;
      }
      const channel = Result.try(
        () => new BroadcastChannel(PRESENTATION_PREFS_CHANNEL),
      );
      if (channel.isErr()) {
        getAnalytics().captureError(channel.error);
        return undefined;
      }
      return channel.value;
    },
  });

let browserSync: PresentationPrefsSync | undefined;

export const initializeBrowserPresentationPrefs = (
  prefs: PresentationPrefs,
): void => {
  if (typeof window !== "undefined") {
    browserSync = createBrowserSync(prefs);
  }
};

const getBrowserSync = (initialPrefs = defaultPresentationPrefs) =>
  (browserSync ??= createBrowserSync(initialPrefs));

export const getBrowserPresentationPrefs = (): PresentationPrefs =>
  browserSync?.getSnapshot() ?? defaultPresentationPrefs;

const savePrefs = (
  sync: PresentationPrefsSync,
  patch: Partial<PresentationPrefs>,
) => {
  detachedUserAction(sync.update(patch), {
    context: "presentation-prefs.save",
    failureMessage: getTranslator()("errors.actionFailed"),
  });
};

export const persistPresentationPrefs = (
  patch: Partial<PresentationPrefs>,
): void => {
  if (typeof window !== "undefined") {
    savePrefs(getBrowserSync(), patch);
  }
};

const PresentationPrefsContext = createContext({
  prefs: defaultPresentationPrefs,
  readerScrollContainers: new Set<RefObject<HTMLElement | null>>(),
  setPrefs: (_patch: Partial<PresentationPrefs>): void => undefined,
});

type PresentationPrefsProviderProps = PropsWithChildren<{
  initialPrefs: PresentationPrefs;
  sync?: PresentationPrefsSync;
}>;

export const PresentationPrefsProvider = ({
  initialPrefs,
  sync: suppliedSync,
  children,
}: PresentationPrefsProviderProps) => {
  const [sync] = useState(
    () =>
      suppliedSync ??
      (typeof window === "undefined"
        ? createPresentationPrefsSync({
            initialPrefs,
            write: async (patch) =>
              await writePresentationPrefs({ data: patch }),
          })
        : getBrowserSync(initialPrefs)),
  );
  const prefs = useSyncExternalStore(
    sync.subscribe,
    sync.getSnapshot,
    () => initialPrefs,
  );
  const [readerScrollContainers] = useState(
    () => new Set<RefObject<HTMLElement | null>>(),
  );
  const setPrefs = (patch: Partial<PresentationPrefs>) =>
    savePrefs(sync, patch);
  return (
    <PresentationPrefsContext
      value={{ prefs, setPrefs, readerScrollContainers }}
    >
      {children}
    </PresentationPrefsContext>
  );
};

export const usePresentationPrefs = () => use(PresentationPrefsContext);

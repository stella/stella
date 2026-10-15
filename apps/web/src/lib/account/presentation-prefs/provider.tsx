import { createContext, use, useState } from "react";
import type { PropsWithChildren } from "react";

import { getTranslator } from "@/i18n/translator";
import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { writePresentationPrefs } from "@/lib/account/presentation-prefs/server";
import { detachedUserAction } from "@/lib/errors/user-toast";

let browserPrefs = defaultPresentationPrefs;

export const initializeBrowserPresentationPrefs = (
  prefs: PresentationPrefs,
): void => {
  if (typeof window !== "undefined") {
    browserPrefs = prefs;
  }
};

export const getBrowserPresentationPrefs = (): PresentationPrefs =>
  browserPrefs;

// Serialize writes so simultaneous controls cannot race response cookies.
let pendingWrite: Promise<unknown> = Promise.resolve();
export const persistPresentationPrefs = (
  patch: Partial<PresentationPrefs>,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  browserPrefs = { ...browserPrefs, ...patch };
  const write = pendingWrite.then(
    async () => await writePresentationPrefs({ data: patch }),
  );
  pendingWrite = write.then(
    () => undefined,
    () => undefined,
  );
  detachedUserAction(write, {
    context: "presentation-prefs.save",
    failureMessage: getTranslator()("errors.actionFailed"),
  });
};

const PresentationPrefsContext = createContext({
  prefs: defaultPresentationPrefs,
  setPrefs: (_patch: Partial<PresentationPrefs>): void => undefined,
});

type PresentationPrefsProviderProps = PropsWithChildren<{
  initialPrefs: PresentationPrefs;
}>;

export const PresentationPrefsProvider = ({
  initialPrefs,
  children,
}: PresentationPrefsProviderProps) => {
  const [prefs, setState] = useState(initialPrefs);
  const setPrefs = (patch: Partial<PresentationPrefs>) => {
    setState((previous) => ({ ...previous, ...patch }));
    persistPresentationPrefs(patch);
  };
  return (
    <PresentationPrefsContext value={{ prefs, setPrefs }}>
      {children}
    </PresentationPrefsContext>
  );
};

export const usePresentationPrefs = () => use(PresentationPrefsContext);

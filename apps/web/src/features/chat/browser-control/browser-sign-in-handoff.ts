import { create } from "zustand";

export type BrowserSignInDecision = "cancel" | "resume";

export type PendingBrowserSignIn = {
  /** Hostname of the site requesting sign-in, when known. */
  host: string | null;
  cancel: () => void;
  resume: () => void;
};

type BrowserSignInStore = {
  pending: PendingBrowserSignIn | null;
};

const useBrowserSignInStore = create<BrowserSignInStore>()(() => ({
  pending: null,
}));

/** Extracts a display hostname from a browser command input, if it carries a URL. */
export const browserCommandHost = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null || !("url" in input)) {
    return null;
  }
  const raw: unknown = Reflect.get(input, "url");
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = URL.parse(raw);
  return parsed !== null && parsed.hostname !== "" ? parsed.hostname : null;
};

/**
 * Pauses browser execution while a docked card above the composer lets the
 * member open the background sign-in tab and continue once signed in.
 */
export const waitForBrowserSignIn = async ({
  host,
  signal,
}: {
  host: string | null;
  signal: AbortSignal;
}): Promise<BrowserSignInDecision> => {
  if (signal.aborted) {
    return "cancel";
  }
  // Supersede any stale prompt cleanly so only one sign-in card is shown.
  useBrowserSignInStore.getState().pending?.cancel();
  return await new Promise<BrowserSignInDecision>((resolve) => {
    let settled = false;
    const finish = (decision: BrowserSignInDecision): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (useBrowserSignInStore.getState().pending === entry) {
        useBrowserSignInStore.setState({ pending: null });
      }
      resolve(decision);
    };
    const onAbort = (): void => {
      finish("cancel");
    };
    const entry: PendingBrowserSignIn = {
      cancel: () => {
        finish("cancel");
      },
      host,
      resume: () => {
        finish("resume");
      },
    };
    signal.addEventListener("abort", onAbort, { once: true });
    useBrowserSignInStore.setState({ pending: entry });
  });
};

/** The pending browser sign-in prompt docked above the composer, if any. */
export const usePendingBrowserSignIn = (): PendingBrowserSignIn | null =>
  useBrowserSignInStore((state) => state.pending);

/** Clears any pending prompt; for tests. */
export const resetBrowserSignInHandoff = (): void => {
  useBrowserSignInStore.getState().pending?.cancel();
  useBrowserSignInStore.setState({ pending: null });
};

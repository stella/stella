import { useSyncExternalStore } from "react";

import { Result } from "better-result";
import * as v from "valibot";

import {
  type BrowserControlCommand,
  isReadOnlyBrowserCommand,
} from "@stll/api-contract/browser-control";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

/**
 * Whether page reads run without a click. Scoped to the web tab session: one
 * stella tab pairs with one controlled Chrome tab, so the grant lives and dies
 * with that pairing rather than with a thread. Every other browser command
 * always asks.
 */
export const BROWSER_APPROVAL_MODE = {
  askEveryTime: "ask-every-time",
  autoApproveReads: "auto-approve-reads",
} as const;

export type BrowserApprovalMode =
  (typeof BROWSER_APPROVAL_MODE)[keyof typeof BROWSER_APPROVAL_MODE];

const STORAGE_KEY = "stella.chat.browserApprovalMode";
// An unknown stored value (a mode an older build offered) parses to null and
// falls back to asking.
const modeSchema = v.picklist(Object.values(BROWSER_APPROVAL_MODE));

/**
 * The only path by which a `use-browser` call runs without a click, and so
 * the single exception to that tool's `neverAuto` grant policy: a page read
 * (`snapshot`) in the reads mode, and only while the last browser command in
 * this tab session succeeded and none is still running. A redirect to an
 * unapproved origin, an unknown outcome or any other failure leaves the
 * controlled tab on a page nobody approved reading, so the next read asks.
 */
export const isBrowserCommandAutoApproved = ({
  command,
  lastCommandSucceeded,
  mode,
}: {
  command: BrowserControlCommand;
  lastCommandSucceeded: boolean;
  mode: BrowserApprovalMode;
}): boolean =>
  mode === BROWSER_APPROVAL_MODE.autoApproveReads &&
  lastCommandSucceeded &&
  isReadOnlyBrowserCommand(command);

export const createBrowserApprovalStore = (getStorage: () => Storage) => {
  const listeners = new Set<() => void>();
  // A throwing storage (blocked site data, sandboxed frame) reads as unset.
  let mode: BrowserApprovalMode =
    readStoredJson(
      Result.try(() => getStorage().getItem(STORAGE_KEY)).unwrapOr(null),
      modeSchema,
    ) ?? BROWSER_APPROVAL_MODE.askEveryTime;
  let commandsInFlight = 0;
  // Bumped by every failed command; a success only counts when its command
  // started after the latest failure, so an older command finishing late
  // cannot vouch for the page a newer failure left behind.
  let failureEpoch = 0;
  let lastSuccessEpoch: number | null = null;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setMode = (next: BrowserApprovalMode): void => {
    mode = next;
    // Blocked site data or a sandboxed frame throws on access; the mode
    // then lasts until reload.
    const storage = Result.try(() => getStorage()).unwrapOr(null);
    if (storage !== null) {
      writeStoredJson(storage, STORAGE_KEY, next);
    }
    notify();
  };

  return {
    /**
     * Marks a browser command as running; call the returned function once
     * with whether it succeeded. Until then no read auto-approves.
     */
    beginCommand(): (succeeded: boolean) => void {
      const startEpoch = failureEpoch;
      commandsInFlight += 1;
      notify();
      let finished = false;
      return (succeeded) => {
        if (finished) {
          return;
        }
        finished = true;
        commandsInFlight -= 1;
        if (!succeeded) {
          failureEpoch += 1;
        } else if (startEpoch === failureEpoch) {
          lastSuccessEpoch = startEpoch;
        }
        notify();
      };
    },
    getMode: (): BrowserApprovalMode => mode,
    lastCommandSucceeded: (): boolean =>
      commandsInFlight === 0 && lastSuccessEpoch === failureEpoch,
    /**
     * Forgets what was approved: the controller re-paired or disconnected,
     * or the user handed chat another tab, so neither the reads opt-in nor
     * the last success speaks for the page chat would read next.
     */
    reset(): void {
      failureEpoch += 1;
      setMode(BROWSER_APPROVAL_MODE.askEveryTime);
    },
    setMode,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

type BrowserApprovalStore = ReturnType<typeof createBrowserApprovalStore>;

let store: BrowserApprovalStore | null = null;

const getStore = (): BrowserApprovalStore => {
  store ??= createBrowserApprovalStore(() => window.sessionStorage);
  return store;
};

const subscribe = (listener: () => void) => getStore().subscribe(listener);

export const setBrowserApprovalMode = (mode: BrowserApprovalMode): void => {
  getStore().setMode(mode);
};

export const beginBrowserCommand = (): ((succeeded: boolean) => void) =>
  getStore().beginCommand();

export const resetBrowserApproval = (): void => {
  getStore().reset();
};

export const useBrowserApprovalMode = (): BrowserApprovalMode =>
  useSyncExternalStore(
    subscribe,
    () => getStore().getMode(),
    () => BROWSER_APPROVAL_MODE.askEveryTime,
  );

export const useBrowserCommandAutoApproved = (
  command: BrowserControlCommand | null,
): boolean =>
  useSyncExternalStore(
    subscribe,
    () =>
      command !== null &&
      isBrowserCommandAutoApproved({
        command,
        lastCommandSucceeded: getStore().lastCommandSucceeded(),
        mode: getStore().getMode(),
      }),
    () => false,
  );

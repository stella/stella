import { useSyncExternalStore } from "react";

import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
  type BrowserControlSnapshot,
  isReadOnlyBrowserCommand,
} from "@stll/api-contract/browser-control";
import {
  BROWSER_SITE_GRANTS_MAX,
  browserSiteGrantOrigin,
} from "@stll/api-contract/browser-site-grants";

import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  onStorageOwnerChange,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

/**
 * Whether page reads run without a click. Scoped to the web tab session: one
 * stella tab pairs with one controlled Chrome tab, so the grant lives and dies
 * with that pairing rather than with a thread.
 */
export const BROWSER_APPROVAL_MODE = {
  askEveryTime: "ask-every-time",
  autoApproveReads: "auto-approve-reads",
} as const;

export type BrowserApprovalMode =
  (typeof BROWSER_APPROVAL_MODE)[keyof typeof BROWSER_APPROVAL_MODE];

const STORAGE_KEY = "stella.chat.browserApprovalMode";
const SITE_GRANT_APPROVALS_KEY = "stella.chat.browserSiteGrantApprovals";
/** Site-grant answers kept for checking their results, newest last. */
const SITE_GRANT_APPROVALS_KEPT = BROWSER_CONTROL_LIMITS.executionReceipts;
// An unknown stored value (a mode an older build offered) parses to null and
// falls back to asking.
const modeSchema = v.picklist(Object.values(BROWSER_APPROVAL_MODE));
const siteGrantApprovalsSchema = v.pipe(
  v.array(
    v.strictObject({
      origins: v.pipe(
        v.array(v.string()),
        v.maxLength(BROWSER_SITE_GRANTS_MAX),
      ),
      toolCallId: v.pipe(
        v.string(),
        v.maxLength(BROWSER_CONTROL_LIMITS.requestIdChars),
      ),
    }),
  ),
  v.maxLength(SITE_GRANT_APPROVALS_KEPT),
);
type SiteGrantApprovals = v.InferOutput<typeof siteGrantApprovalsSchema>;

/**
 * The controlled tab's page as the extension reported it in the last
 * successful result: never a URL the model wrote.
 */
export type BrowserObservedPage = {
  revision: string;
  url: string;
  /**
   * Element refs the extension reported a value for. The extension withholds
   * the value of every field it treats as secret (passwords, payment cards,
   * one-time codes), so a ref outside this set may be one.
   */
  valueRefs: ReadonlySet<string>;
};

export const toBrowserObservedPage = (
  snapshot: BrowserControlSnapshot,
): BrowserObservedPage => ({
  revision: snapshot.revision,
  url: snapshot.url,
  valueRefs: new Set(
    snapshot.elements
      .filter((element) => element.value !== undefined)
      .map((element) => element.ref),
  ),
});

/**
 * The website a command acts on or moves to, by exact origin, or null when
 * it cannot be known before the command runs. A command on the page reads
 * that page's origin from the extension's last report, and only when the
 * command names that very page; a navigation names its destination, which
 * the extension holds it to (`open` refuses to read across a redirect,
 * `switch-tab` needs the tab still on that origin).
 */
export const browserCommandSite = ({
  command,
  observedPage,
}: {
  command: BrowserControlCommand;
  observedPage: BrowserObservedPage | null;
}): string | null => {
  const pageOrigin =
    observedPage === null ? null : browserSiteGrantOrigin(observedPage.url);
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.open:
    case BROWSER_CONTROL_ACTION.switchTab:
      return browserSiteGrantOrigin(command.url);
    // Where going back leads is checked after it ran.
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.snapshot:
      return pageOrigin;
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select:
      return observedPage !== null &&
        command.page.url === observedPage.url &&
        command.page.revision === observedPage.revision
        ? pageOrigin
        : null;
    default:
      command satisfies never;
      return panic("Unhandled browser command action");
  }
};

/**
 * Whether a website approval may answer this command at all. Typing into a
 * field the extension did not report a value for may be typing a secret, so
 * it always asks.
 */
const isCoveredBySiteGrant = ({
  command,
  observedPage,
}: {
  command: BrowserControlCommand;
  observedPage: BrowserObservedPage | null;
}): boolean =>
  command.action !== BROWSER_CONTROL_ACTION.fill ||
  (observedPage?.valueRefs.has(command.target.ref) ?? false);

export type BrowserAutoApproval =
  | { type: "ask" }
  | { type: "reads-mode" }
  /** `origin` is the allowed site the command acts on or moves to. */
  | { type: "site-grant"; origin: string };

const ASK: BrowserAutoApproval = { type: "ask" };

/**
 * The only paths by which a `use-browser` call runs without a click, and so
 * the exceptions to that tool's `neverAuto` grant policy:
 *
 * - a page read (`snapshot`) in the reads mode;
 * - any command on, or navigating to, a website the user allowed, keyed by
 *   exact origin. The site comes from the extension's report of the
 *   controlled tab, or for a navigation from its destination; a fill into a
 *   field that may hold a secret still asks.
 *
 * Both need the last browser command in this tab session to have succeeded
 * with none still running: a redirect or a result landing on a site nobody
 * allowed, an unknown outcome or any other failure leaves the controlled tab
 * on a page nobody approved, so the next command asks.
 */
export const decideBrowserAutoApproval = ({
  command,
  grantedOrigins,
  lastCommandSucceeded,
  mode,
  observedPage,
}: {
  command: BrowserControlCommand;
  grantedOrigins: ReadonlySet<string>;
  lastCommandSucceeded: boolean;
  mode: BrowserApprovalMode;
  observedPage: BrowserObservedPage | null;
}): BrowserAutoApproval => {
  if (!lastCommandSucceeded) {
    return ASK;
  }
  if (
    mode === BROWSER_APPROVAL_MODE.autoApproveReads &&
    isReadOnlyBrowserCommand(command)
  ) {
    return { type: "reads-mode" };
  }
  const site = browserCommandSite({ command, observedPage });
  return site !== null &&
    grantedOrigins.has(site) &&
    isCoveredBySiteGrant({ command, observedPage })
    ? { type: "site-grant", origin: site }
    : ASK;
};

export const createBrowserApprovalStore = (getStorage: () => Storage) => {
  const listeners = new Set<() => void>();
  // A throwing storage (blocked site data, sandboxed frame) reads as unset.
  const readItem = (key: string): string | null =>
    Result.try(() => getStorage().getItem(userStorageKey(key))).unwrapOr(null);
  const readMode = (): BrowserApprovalMode =>
    readStoredJson(readItem(STORAGE_KEY), modeSchema) ??
    BROWSER_APPROVAL_MODE.askEveryTime;
  const readSiteGrantApprovals = (): SiteGrantApprovals =>
    readStoredJson(
      readItem(SITE_GRANT_APPROVALS_KEY),
      siteGrantApprovalsSchema,
    ) ?? [];
  let mode = readMode();
  let observedPage: BrowserObservedPage | null = null;
  let commandsInFlight = 0;
  let ownerEpoch = 0;
  // Bumped by every failed command; a success only counts when its command
  // started after the latest failure, so an older command finishing late
  // cannot vouch for the page a newer failure left behind.
  let failureEpoch = 0;
  let lastSuccessEpoch: number | null = null;
  // Bumped on every change, so a subscriber reads one consistent snapshot.
  let version = 0;

  const notify = () => {
    version += 1;
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
      writeStoredJson(storage, userStorageKey(STORAGE_KEY), next);
    }
    notify();
  };

  return {
    /**
     * Marks a browser command as running; call the returned function once
     * with whether it succeeded. Until then nothing auto-approves.
     */
    beginCommand(): (succeeded: boolean) => void {
      const startEpoch = failureEpoch;
      const startOwnerEpoch = ownerEpoch;
      commandsInFlight += 1;
      notify();
      let finished = false;
      return (succeeded) => {
        if (finished) {
          return;
        }
        finished = true;
        if (startOwnerEpoch !== ownerEpoch) {
          return;
        }
        commandsInFlight -= 1;
        if (!succeeded) {
          failureEpoch += 1;
        } else if (startEpoch === failureEpoch) {
          lastSuccessEpoch = startEpoch;
        }
        notify();
      };
    },
    /** The observable store keeps its subscribers as each account is read. */
    restoreOwner(): void {
      ownerEpoch += 1;
      commandsInFlight = 0;
      failureEpoch = 0;
      lastSuccessEpoch = null;
      observedPage = null;
      mode = readMode();
      notify();
    },
    getMode: (): BrowserApprovalMode => mode,
    getObservedPage: (): BrowserObservedPage | null => observedPage,
    getVersion: (): number => version,
    lastCommandSucceeded: (): boolean =>
      commandsInFlight === 0 && lastSuccessEpoch === failureEpoch,
    /** What the extension last reported the controlled tab shows. */
    observePage(next: BrowserObservedPage | null): void {
      observedPage = next;
      notify();
    },
    /**
     * Remembers that a website approval answered `toolCallId`, with the sites
     * allowed then, before the answer is sent; false when it cannot be kept,
     * and the card then asks. Kept in the tab session, so a result that
     * arrives after a reload is still checked.
     */
    recordSiteGrantApproval(
      toolCallId: string,
      origins: ReadonlySet<string>,
    ): boolean {
      const storage = Result.try(() => getStorage()).unwrapOr(null);
      if (storage === null) {
        return false;
      }
      const next = [
        ...readSiteGrantApprovals().filter(
          (entry) => entry.toolCallId !== toolCallId,
        ),
        { origins: [...origins], toolCallId },
      ].slice(-SITE_GRANT_APPROVALS_KEPT);
      const key = userStorageKey(SITE_GRANT_APPROVALS_KEY);
      writeStoredJson(storage, key, next);
      return (
        readStoredJson(
          readItem(SITE_GRANT_APPROVALS_KEY),
          siteGrantApprovalsSchema,
        )?.some((entry) => entry.toolCallId === toolCallId) ?? false
      );
    },
    /** The sites allowed when a website approval answered `toolCallId`. */
    siteGrantApprovalFor(toolCallId: string): ReadonlySet<string> | null {
      const entry = readSiteGrantApprovals().find(
        (candidate) => candidate.toolCallId === toolCallId,
      );
      return entry === undefined ? null : new Set(entry.origins);
    },
    /**
     * Forgets what was approved: the controller re-paired or disconnected,
     * or the user handed chat another tab, so neither the reads opt-in nor
     * the last success speaks for the page chat would read next.
     */
    reset(): void {
      failureEpoch += 1;
      observedPage = null;
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
  store ??= createBrowserApprovalStore(() => browserStateStorage("session"));
  return store;
};

onStorageOwnerChange(() => {
  store?.restoreOwner();
});

export const subscribeBrowserApproval = (listener: () => void) =>
  getStore().subscribe(listener);

export const getBrowserApprovalMode = (): BrowserApprovalMode =>
  getStore().getMode();

export const setBrowserApprovalMode = (mode: BrowserApprovalMode): void => {
  getStore().setMode(mode);
};

export const beginBrowserCommand = (): ((succeeded: boolean) => void) =>
  getStore().beginCommand();

export const resetBrowserApproval = (): void => {
  getStore().reset();
};

export const observeBrowserPage = (page: BrowserObservedPage | null): void => {
  getStore().observePage(page);
};

export const recordBrowserSiteGrantApproval = (
  toolCallId: string,
  origins: ReadonlySet<string>,
): boolean => getStore().recordSiteGrantApproval(toolCallId, origins);

export const browserSiteGrantApprovalFor = (
  toolCallId: string,
): ReadonlySet<string> | null => getStore().siteGrantApprovalFor(toolCallId);

export const useBrowserApprovalMode = (): BrowserApprovalMode =>
  useSyncExternalStore(
    subscribeBrowserApproval,
    getBrowserApprovalMode,
    () => BROWSER_APPROVAL_MODE.askEveryTime,
  );

const useBrowserApprovalVersion = (): number =>
  useSyncExternalStore(
    subscribeBrowserApproval,
    () => getStore().getVersion(),
    () => 0,
  );

/** The page the extension last reported, for the card's site label. */
export const useBrowserObservedPage = (): BrowserObservedPage | null => {
  useBrowserApprovalVersion();
  return getStore().getObservedPage();
};

/**
 * How a browser command card may answer itself now. Recomputed on every
 * change of the approval state; the inputs are the extension's reports, the
 * stored website approvals and the command.
 */
export const useBrowserAutoApproval = ({
  command,
  grantedOrigins,
}: {
  command: BrowserControlCommand | null;
  grantedOrigins: ReadonlySet<string>;
}): BrowserAutoApproval => {
  useBrowserApprovalVersion();
  if (command === null) {
    return ASK;
  }
  const current = getStore();
  return decideBrowserAutoApproval({
    command,
    grantedOrigins,
    lastCommandSucceeded: current.lastCommandSucceeded(),
    mode: current.getMode(),
    observedPage: current.getObservedPage(),
  });
};

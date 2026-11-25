import { useSyncExternalStore } from "react";

import { panic } from "better-result";

import {
  BROWSER_CONTROL_ERROR_CODE,
  type BrowserControlCommand,
  type BrowserControlResult,
  type BrowserControlSnapshot,
} from "@stll/api-contract/browser-control";
import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import {
  type BrowserReportedPage,
  type BrowserStepDecision,
  decideBrowserStep,
} from "@stll/api-contract/browser-step-gate";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import { onStorageOwnerChange } from "@/lib/account/user-scoped-storage";

/**
 * What the extension last reported about the controlled tab, which the
 * shared browser gate (`decideBrowserStep`) judges a chat's next browser
 * command by. Scoped to the web tab: one stella tab pairs with one
 * controlled Chrome tab, so the report lives and dies with that pairing
 * rather than with a thread. Beside it, per chat: the websites the chat has
 * been on, and the permission level each of its turns was sent with.
 */

/** Turns whose permission level is kept, across every chat of the web tab. */
const TRACKED_TURN_LEVELS = 256;

const NO_VISITS: ReadonlySet<string> = new Set();

const turnKey = (threadId: string, turnId: string) =>
  `${threadId}\u0000${turnId}`;

/** The controlled tab's page from a successful result: never a URL the model wrote. */
const toBrowserReportedPage = (
  snapshot: BrowserControlSnapshot,
): BrowserReportedPage => ({
  revision: snapshot.revision,
  url: snapshot.url,
  valueRefs: new Set(
    snapshot.elements
      .filter((element) => element.value !== undefined)
      .map((element) => element.ref),
  ),
});

/**
 * Whether the tab's page waits for the member's sign-in after `result`: a
 * hand-over says so, a read of a page says it no longer does, and any other
 * answer leaves it as it was.
 */
const signInAfter = (
  before: boolean,
  result: BrowserControlResult,
): boolean => {
  switch (result.status) {
    case "success":
    case "found":
      return false;
    case "error":
      return result.code === BROWSER_CONTROL_ERROR_CODE.needsMember
        ? true
        : before;
    default:
      result satisfies never;
      return panic("Unhandled browser result status");
  }
};

export const createBrowserApprovalState = () => {
  const listeners = new Set<() => void>();
  // The websites each chat has been on, by thread: the origins of pages the
  // extension reported for the chat's commands.
  const visited = new Map<string, Set<string>>();
  // The permission level each chat turn was sent with, by thread and turn.
  const turnLevels = new Map<string, DesktopRunnerApprovalMode>();
  // Bumped by every reset: an answer to a request sent under an earlier
  // pairing says nothing of the tab now controlled.
  let pairing = 0;
  let reportedPage: BrowserReportedPage | null = null;
  let signIn = false;
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

  /**
   * The page the browser last reported, only while the latest command
   * settled on it: a failure, an unknown outcome or a command still running
   * leaves the tab on a page nobody reported.
   */
  const settledPage = (): BrowserReportedPage | null =>
    commandsInFlight === 0 && lastSuccessEpoch === failureEpoch
      ? reportedPage
      : null;

  return {
    /**
     * Marks a browser command as running; call the returned function once
     * with whether it succeeded. Until then no page counts as reported.
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
    /** The observable state keeps its subscribers as each account is read. */
    restoreOwner(): void {
      ownerEpoch += 1;
      pairing += 1;
      visited.clear();
      turnLevels.clear();
      commandsInFlight = 0;
      failureEpoch = 0;
      lastSuccessEpoch = null;
      reportedPage = null;
      signIn = false;
      notify();
    },
    /** How the shared gate answers `command` at `level` now. */
    decide({
      command,
      grantedOrigins,
      level,
      threadId,
    }: BrowserStepDecisionInput): BrowserStepDecision {
      return decideBrowserStep({
        command,
        grantedOrigins,
        level,
        reportedPage: settledPage(),
        signIn,
        visitedOrigins:
          threadId === null ? NO_VISITS : (visited.get(threadId) ?? NO_VISITS),
      });
    },
    getVersion: (): number => version,
    /** The pairing a request is sent under (`observeResult`'s `sentUnder`). */
    pairing: (): number => pairing,
    /**
     * What the extension answered for the controlled tab. An answer to a
     * request sent under an earlier pairing (`sentUnder`) changes nothing.
     * A `find` reports only the page's address: on another address than the
     * reported page, that page no longer counts.
     */
    observeResult(result: BrowserControlResult, sentUnder?: number): void {
      if (sentUnder !== undefined && sentUnder !== pairing) {
        return;
      }
      if (result.status === "success") {
        reportedPage = toBrowserReportedPage(result.snapshot);
      } else if (
        result.status === "found" &&
        reportedPage !== null &&
        result.found.url !== reportedPage.url
      ) {
        reportedPage = null;
      }
      signIn = signInAfter(signIn, result);
      notify();
    },
    /** Records the website a chat's command reported a page from. */
    observeVisit(threadId: string, result: BrowserControlResult): void {
      if (result.status !== "success") {
        return;
      }
      const origin = browserSiteGrantOrigin(result.snapshot.url);
      if (origin === null) {
        return;
      }
      const chat = visited.get(threadId) ?? new Set<string>();
      if (chat.has(origin)) {
        return;
      }
      chat.add(origin);
      visited.set(threadId, chat);
      notify();
    },
    /** Keeps the permission level a chat turn was sent with. */
    recordTurnLevel(
      threadId: string,
      turnId: string,
      level: DesktopRunnerApprovalMode,
    ): void {
      const key = turnKey(threadId, turnId);
      turnLevels.delete(key);
      turnLevels.set(key, level);
      // A Map iterates in insertion order, so the first key is the oldest.
      if (turnLevels.size > TRACKED_TURN_LEVELS) {
        const [oldest] = turnLevels.keys();
        if (oldest !== undefined) {
          turnLevels.delete(oldest);
        }
      }
    },
    /** The level a chat turn was sent with; null for one not sent here. */
    turnLevel(
      threadId: string,
      turnId: string,
    ): DesktopRunnerApprovalMode | null {
      return turnLevels.get(turnKey(threadId, turnId)) ?? null;
    },
    /**
     * Forgets what the extension reported: the controller re-paired or
     * disconnected, or the user handed chat another tab.
     */
    reset(): void {
      failureEpoch += 1;
      pairing += 1;
      reportedPage = null;
      signIn = false;
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** What a browser command is decided by, besides what the extension reported. */
type BrowserStepDecisionInput = {
  command: BrowserControlCommand;
  grantedOrigins: ReadonlySet<string>;
  level: DesktopRunnerApprovalMode;
  /** The chat the command is for; null where none is known, which has been on no website. */
  threadId: string | null;
};

type BrowserApprovalState = ReturnType<typeof createBrowserApprovalState>;

let state: BrowserApprovalState | null = null;

const getState = (): BrowserApprovalState => {
  state ??= createBrowserApprovalState();
  return state;
};

onStorageOwnerChange(() => {
  state?.restoreOwner();
});

export const beginBrowserCommand = (): ((succeeded: boolean) => void) =>
  getState().beginCommand();

export const resetBrowserApproval = (): void => {
  getState().reset();
};

/** The pairing a request to the extension is sent under. */
export const browserApprovalPairing = (): number => getState().pairing();

export const observeBrowserResult = (
  result: BrowserControlResult,
  sentUnder: number,
): void => {
  getState().observeResult(result, sentUnder);
};

export const observeBrowserVisit = (
  threadId: string,
  result: BrowserControlResult,
): void => {
  getState().observeVisit(threadId, result);
};

export const recordBrowserTurnLevel = (
  threadId: string,
  turnId: string,
  level: DesktopRunnerApprovalMode,
): void => {
  getState().recordTurnLevel(threadId, turnId, level);
};

export const browserTurnLevel = (
  threadId: string,
  turnId: string,
): DesktopRunnerApprovalMode | null => getState().turnLevel(threadId, turnId);

/**
 * How the shared gate answers a browser command at this moment, read outside
 * React: a card decides again with it after an await, and the executor right
 * before a command runs, so a pairing reset or a failed command in the
 * meantime counts.
 */
export const currentBrowserStepDecision = (
  input: BrowserStepDecisionInput,
): BrowserStepDecision => getState().decide(input);

const subscribeBrowserApproval = (listener: () => void) =>
  getState().subscribe(listener);
const browserApprovalVersion = () => getState().getVersion();

const useBrowserApprovalVersion = (): number =>
  useSyncExternalStore(
    subscribeBrowserApproval,
    browserApprovalVersion,
    () => 0,
  );

/**
 * How the shared gate answers a browser command card now; recomputed on
 * every change of what the extension reported. Null without a command.
 */
export const useBrowserStepDecision = ({
  command,
  ...input
}: Omit<BrowserStepDecisionInput, "command"> & {
  command: BrowserControlCommand | null;
}): BrowserStepDecision | null => {
  useBrowserApprovalVersion();
  return command === null
    ? null
    : currentBrowserStepDecision({ ...input, command });
};

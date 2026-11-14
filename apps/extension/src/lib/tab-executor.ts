import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlElementCommand,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  type BrowserControlTab,
  type BrowserObservedTab,
  ELEMENT_REFERENCE_SHADOW_SEGMENT,
  parseBrowserControlResult,
  parseElementReference,
} from "@stll/api-contract/browser-control";
import { sleep } from "@stll/concurrency/sleep";

import { browserControlError } from "./browser-control-result";
import type { CommandBudget } from "./command-budget";
import { readBrowserController } from "./controller";
import { isControllableFrame, parseControllableUrl } from "./origin-policy";
import {
  type FindRequest,
  type PageOperation,
  pageScript,
  SNAPSHOT_PURPOSE,
} from "./page-script";
import {
  findInPage,
  frameFoundSchema,
  type FrameOutcome,
  frameReadSchema,
  type PageReadFailure,
  type ReaderFrame,
  readPageWindow,
} from "./page-window";
import {
  IDENTITY_PROVIDER_HOSTS,
  isIdentityProviderUrl,
  needsMember,
  SIGN_IN_MESSAGE,
  SIGN_IN_POLICY,
  type SignInPolicy,
} from "./sign-in-policy";
import {
  checkCommandIdentity,
  type LiveTopDocument,
  type SnapshotState,
  type TopDocument,
} from "./snapshot-guard";
import { readStellaTabs } from "./stella-tabs";
import { BROWSER_CONTROLLED_TAB_STORAGE_KEY } from "./storage-keys";
import {
  chatTabsAtLimit,
  containControlledTab,
  forgetContainedTab,
  operableTabIds,
  readContainedTabs,
  readTabOwner,
  reclaimControlledTab,
  switchContainedTab,
} from "./tab-containment";

const NAVIGATION_TIMEOUT_MS = 15_000;
const PAGE_SETTLE_MS = 250;
const TAB_STATUS_POLL_MS = 100;
/** Snapshots retried when the page navigates while one is being read. */
const OUTCOME_SNAPSHOT_ATTEMPTS = 3;
const TOP_FRAME_ID = 0;
const UNSUPPORTED_PAGE_MESSAGE =
  "Only public HTTPS pages can be read or operated. Open one first.";

/**
 * A dispatched action whose result was not observed. Repeating it could
 * submit, pay or delete twice, so the model must read the page first.
 */
const outcomeUnknown = (detail: string): BrowserControlResult =>
  browserControlError(
    BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    `${detail} The action may have taken effect; take a snapshot before retrying it.`,
  );

/**
 * Read through a call: TypeScript keeps a checked `signal.aborted` narrowed
 * across awaits, but a stop can land during any of them.
 */
const isStopped = (signal: AbortSignal): boolean => signal.aborted;

const STOPPED_AFTER_DISPATCH =
  "The action was stopped before its outcome was observed.";

/** Stopped before anything reached the page, so nothing ran. */
const cancelled = (): BrowserControlResult =>
  browserControlError(
    BROWSER_CONTROL_ERROR_CODE.cancelled,
    "The browser action was stopped before it ran.",
  );

/** A frame's answer to a snapshot when its document asks for a sign-in. */
const signInRefusalSchema = v.strictObject({ refused: v.literal("sign-in") });

/** A frame's answer when it read nothing (see `FrameRefusal`). */
const pageRefusalSchema = v.strictObject({
  refused: v.picklist(["sign-in", "stale-cursor", "top-origin"]),
});

const frameLocationSchema = v.strictObject({
  origin: v.string(),
  url: v.string(),
});

const isBrowserControlErrorCode = (
  input: string,
): input is BrowserControlErrorCode =>
  Object.values(BROWSER_CONTROL_ERROR_CODE).some(
    (errorCode) => errorCode === input,
  );

type ControlledTabState = {
  /** The user handed this tab over from the popup; chat did not open it. */
  adopted: boolean;
  controllerId: string;
  /**
   * The top document when the last command ended: what chat last saw a
   * result for. Null until a command has run in this tab.
   */
  settled: TopDocument | null;
  /** Null until the tab is read, and again once an action may have changed it. */
  snapshot: SnapshotState | null;
  tabId: number;
};

const parseTopDocument = (input: unknown): TopDocument | null =>
  typeof input === "object" &&
  input !== null &&
  "documentId" in input &&
  (typeof input.documentId === "string" || input.documentId === null) &&
  "url" in input &&
  (typeof input.url === "string" || input.url === null)
    ? { documentId: input.documentId, url: input.url }
    : null;

const isTabId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const parseSnapshotState = (input: unknown): SnapshotState | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("documents" in input) ||
    typeof input.documents !== "object" ||
    input.documents === null ||
    !("revision" in input) ||
    typeof input.revision !== "string" ||
    !("tabId" in input) ||
    !isTabId(input.tabId) ||
    !("url" in input) ||
    typeof input.url !== "string"
  ) {
    return null;
  }
  return {
    documents: Object.fromEntries(
      Object.entries(input.documents).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    revision: input.revision,
    tabId: input.tabId,
    url: input.url,
  };
};

const parseControlledTabState = (input: unknown): ControlledTabState | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("adopted" in input) ||
    typeof input.adopted !== "boolean" ||
    !("controllerId" in input) ||
    typeof input.controllerId !== "string" ||
    !("snapshot" in input) ||
    !("tabId" in input) ||
    !isTabId(input.tabId)
  ) {
    return null;
  }
  return {
    adopted: input.adopted,
    controllerId: input.controllerId,
    settled: "settled" in input ? parseTopDocument(input.settled) : null,
    snapshot: parseSnapshotState(input.snapshot),
    tabId: input.tabId,
  };
};

const readControlledTabState = async (): Promise<ControlledTabState | null> => {
  const stored = await chrome.storage.session.get(
    BROWSER_CONTROLLED_TAB_STORAGE_KEY,
  );
  return parseControlledTabState(stored[BROWSER_CONTROLLED_TAB_STORAGE_KEY]);
};

const writeControlledTabState = async (
  state: ControlledTabState,
): Promise<void> => {
  await chrome.storage.session.set({
    [BROWSER_CONTROLLED_TAB_STORAGE_KEY]: state,
  });
};

/** The tab the controller's chat operates, or null when there is none. */
export const readControlledTabId = async (
  controllerId: string,
): Promise<number | null> => {
  const state = await readControlledTabState();
  return state?.controllerId === controllerId ? state.tabId : null;
};

/** Returns whether `tabId` was the controlled tab. */
export const forgetControlledTab = async (tabId: number): Promise<boolean> => {
  const state = await readControlledTabState();
  if (state?.tabId !== tabId) {
    return false;
  }
  await chrome.storage.session.remove(BROWSER_CONTROLLED_TAB_STORAGE_KEY);
  await forgetContainedTab(tabId);
  return true;
};

/**
 * Chrome swapped the controlled tab for another: the new tab is the
 * controlled one, and its document is not the one chat read. Returns
 * whether `removedTabId` was the controlled tab.
 */
export const replaceControlledTab = async (
  addedTabId: number,
  removedTabId: number,
): Promise<boolean> => {
  const state = await readControlledTabState();
  if (state?.tabId !== removedTabId) {
    return false;
  }
  await writeControlledTabState({
    adopted: state.adopted,
    controllerId: state.controllerId,
    settled: state.settled,
    snapshot: null,
    tabId: addedTabId,
  });
  return true;
};

/** Refs from the last snapshot stop matching once an action is dispatched. */
const forgetSnapshot = async (state: ControlledTabState): Promise<void> => {
  await writeControlledTabState({ ...state, snapshot: null });
};

const readControlledTab = async (
  controllerId: string,
): Promise<{ state: ControlledTabState; tab: chrome.tabs.Tab } | null> => {
  const state = await readControlledTabState();
  if (state?.controllerId !== controllerId) {
    return null;
  }

  try {
    return { state, tab: await chrome.tabs.get(state.tabId) };
  } catch {
    await chrome.storage.session.remove(BROWSER_CONTROLLED_TAB_STORAGE_KEY);
    await forgetContainedTab(state.tabId);
    return null;
  }
};

/** Resolves true when `promise` settles first, false after `ms` or on abort. */
const settlesWithin = async (
  promise: Promise<unknown>,
  ms: number,
  signal: AbortSignal,
): Promise<boolean> => {
  // Ends the timer as soon as the race is decided or the command stops.
  const settled = new AbortController();
  const onStop = () => {
    settled.abort();
  };
  signal.addEventListener("abort", onStop, { once: true });
  try {
    return await Promise.race([
      promise.then(() => !isStopped(signal)),
      sleep(ms, { signal: settled.signal })
        .catch((error: unknown) => {
          if (
            settled.signal.aborted &&
            Object.is(error, settled.signal.reason)
          ) {
            return;
          }
          throw error;
        })
        .then(() => false),
    ]);
  } finally {
    signal.removeEventListener("abort", onStop);
    settled.abort();
  }
};

/** A timer that only flags expiry; `clear` it once the wait is over. */
const startDeadline = (ms: number) => {
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
  }, ms);
  return {
    clear() {
      clearTimeout(timeout);
    },
    expired: () => expired,
  };
};

type Deadline = ReturnType<typeof startDeadline>;

/** Polls the tab until `isLoaded` holds, `deadline` expires or `signal` aborts. */
const waitForTab = async (
  tabId: number,
  deadline: Deadline,
  isLoaded: (tab: chrome.tabs.Tab) => boolean,
  signal: AbortSignal,
): Promise<boolean> => {
  for (;;) {
    if (signal.aborted) {
      return false;
    }
    if (isLoaded(await chrome.tabs.get(tabId))) {
      return true;
    }
    if (deadline.expired()) {
      return false;
    }
    await sleep(TAB_STATUS_POLL_MS, { signal }).catch((error: unknown) => {
      if (signal.aborted && Object.is(error, signal.reason)) {
        return;
      }
      throw error;
    });
  }
};

/**
 * `chrome.tabs.goBack` rejects on some Chromium builds even with a back
 * entry present; the page's own history API is the portable path. Only a tab
 * whose document cannot run scripts (an error page) still needs the tabs API.
 */
const navigateBack = async (tabId: number): Promise<void> => {
  try {
    await chrome.scripting.executeScript({
      func: () => {
        window.history.back();
      },
      target: { tabId },
    });
  } catch {
    await chrome.tabs.goBack(tabId);
  }
};

/**
 * Watches the tab's top-level navigations from before a navigation or action
 * is dispatched. `generation` counts navigation starts, so a caller can tell
 * that one began while it was reading the page.
 */
const createTabNavigationObserver = (tabId: number) => {
  let generation = 0;
  let resolveStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const listener = (
    updatedTabId: number,
    changeInfo: { status?: string; url?: string },
  ): void => {
    if (
      updatedTabId === tabId &&
      (changeInfo.status === "loading" || changeInfo.url !== undefined)
    ) {
      generation += 1;
      resolveStarted();
    }
  };
  chrome.tabs.onUpdated.addListener(listener);

  return {
    dispose() {
      chrome.tabs.onUpdated.removeListener(listener);
    },
    generation: () => generation,
    /**
     * Waits for a navigation dispatched after the observer was created to
     * finish. A tab created at `about:blank` has not navigated until it has
     * left `about:blank`.
     */
    async waitForNavigation(signal: AbortSignal): Promise<boolean> {
      const deadline = startDeadline(NAVIGATION_TIMEOUT_MS);
      try {
        if (!(await settlesWithin(started, NAVIGATION_TIMEOUT_MS, signal))) {
          return false;
        }
        return await waitForTab(
          tabId,
          deadline,
          (tab) => tab.status !== "loading" && tab.url !== "about:blank",
          signal,
        );
      } finally {
        deadline.clear();
      }
    },
    /**
     * Waits for the page to be idle after an action: a navigation the action
     * starts within the grace period is awaited to completion. One that
     * starts later is caught by comparing `generation` around the snapshot.
     */
    async waitForSettled(signal: AbortSignal): Promise<boolean> {
      await settlesWithin(started, PAGE_SETTLE_MS, signal);
      const deadline = startDeadline(NAVIGATION_TIMEOUT_MS);
      try {
        return await waitForTab(
          tabId,
          deadline,
          (tab) => tab.status !== "loading",
          signal,
        );
      } finally {
        deadline.clear();
      }
    },
  };
};

type TabNavigationObserver = ReturnType<typeof createTabNavigationObserver>;

/**
 * A value `chrome.scripting.executeScript` hands to the injected function as
 * it was sent. Chrome drops an object property whose value is `null`, so the
 * page would read `undefined` there; no injected argument may hold one.
 * `undefined` is allowed: it arrives as itself.
 */
type InjectableArgument =
  | boolean
  | number
  | string
  | undefined
  | readonly InjectableArgument[]
  | { readonly [key: string]: InjectableArgument };

/**
 * Runs the page script (`page-script`) in frames of the controlled tab.
 * Chrome serializes it, so all operations share its single copy. Element
 * paths and reading positions are frame-local; the worker qualifies them
 * with the frame and its document. Every operation reports or checks the
 * frame's origin, which the worker holds to the origin policy.
 */
const runPageOperation = async (
  injectionTarget: chrome.scripting.InjectionTarget,
  operation: PageOperation & InjectableArgument,
) =>
  await chrome.scripting.executeScript({
    args: [operation],
    func: pageScript,
    target: injectionTarget,
  });

type ActionFrameCheck =
  { error: BrowserControlResult; ok: false } | { ok: true; origin: string };

/**
 * Reads the origin of the document an element ref points into and holds it
 * to the origin policy before anything is dispatched there. The document is
 * addressed by the id the snapshot recorded, so a frame that loaded another
 * document since, even at the same URL, is refused as stale.
 */
const checkActionFrame = async (
  tabId: number,
  frameId: number,
  documentId: string,
): Promise<ActionFrameCheck> => {
  let results: Awaited<ReturnType<typeof runPageOperation>>;
  try {
    results = await runPageOperation(
      { documentIds: [documentId], tabId },
      { kind: "locate" },
    );
  } catch {
    return {
      error: browserControlError(
        BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
        "The frame loaded another document after the page snapshot. Take a new snapshot before acting.",
      ),
      ok: false,
    };
  }
  const location = v.safeParse(frameLocationSchema, results.at(0)?.result);
  if (
    !location.success ||
    !isControllableFrame({
      isTopFrame: frameId === TOP_FRAME_ID,
      ...location.output,
    })
  ) {
    return {
      error: browserControlError(
        BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
        "The element is in a frame outside the public HTTPS pages stella may operate.",
      ),
      ok: false,
    };
  }
  return { ok: true, origin: location.output.origin };
};

/**
 * `refused`: the page script returned before acting. `unobserved`: the
 * action was handed to the page but no verdict came back, so it may have
 * run.
 */
type DomActionOutcome =
  | { code: BrowserControlErrorCode; error: string; status: "refused" }
  | { status: "dispatched" }
  | { status: "unobserved" };

type InjectDomActionOptions = {
  command: BrowserControlElementCommand;
  documentId: string;
  /** The frame origin the worker checked; the action refuses any other. */
  expectedOrigin: string;
  path: string;
  signIn: SignInPolicy;
  tabId: number;
};

const injectDomAction = async ({
  command,
  documentId,
  expectedOrigin,
  path,
  signIn,
  tabId,
}: InjectDomActionOptions): Promise<DomActionOutcome> => {
  let results: Awaited<ReturnType<typeof runPageOperation>>;
  try {
    results = await runPageOperation(
      { documentIds: [documentId], tabId },
      {
        action: command,
        errorCode: BROWSER_CONTROL_ERROR_CODE,
        expectedOrigin,
        kind: "action",
        limits: BROWSER_CONTROL_LIMITS,
        metadataType: BROWSER_CONTROL_TARGET_METADATA,
        path,
        shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
        signIn,
        signInMessage: SIGN_IN_MESSAGE,
        signInPolicies: SIGN_IN_POLICY,
        identityProviderHosts: IDENTITY_PROVIDER_HOSTS,
      },
    );
  } catch {
    return { status: "unobserved" };
  }
  const result: unknown = results.at(0)?.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    typeof result.ok !== "boolean"
  ) {
    return { status: "unobserved" };
  }
  if (result.ok) {
    return { status: "dispatched" };
  }
  const code =
    "code" in result &&
    typeof result.code === "string" &&
    isBrowserControlErrorCode(result.code)
      ? result.code
      : BROWSER_CONTROL_ERROR_CODE.executionFailed;
  return {
    code,
    error:
      "error" in result && typeof result.error === "string"
        ? result.error
        : "The page rejected the action.",
    status: "refused",
  };
};

/**
 * A tab's address as chat's tab list shows it: origin and path only. Query
 * strings and fragments can carry what a page put there for itself, and
 * `switch-tab` matches on the origin. Null for a page chat may not operate.
 */
const listedTabUrl = (rawUrl: string): string | null => {
  const url = parseControllableUrl(rawUrl);
  return url === null
    ? null
    : `${url.origin}${url.pathname}`.slice(0, BROWSER_CONTROL_LIMITS.urlChars);
};

/**
 * Chat's tabs for a snapshot: the one just read first, at the URL that read
 * returned; then chat's others, newest first, at the URL Chrome reports.
 * Tabs that are only confined are never listed. A tab on a page chat may not
 * operate (an error page, another scheme) is left out, since chat could not
 * switch to it.
 */
const listChatTabs = async (
  activeTabId: number,
  activeUrl: string,
): Promise<BrowserControlTab[]> => {
  const others = operableTabIds(await readContainedTabs())
    .filter((tabId) => tabId !== activeTabId)
    .toReversed();
  const tabs = await Promise.all(
    others.map(async (tabId): Promise<BrowserControlTab | null> => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const url = tab?.url !== undefined ? listedTabUrl(tab.url) : null;
      return url === null ? null : { active: false, tabId, url };
    }),
  );
  const active = listedTabUrl(activeUrl);
  return [
    ...(active === null
      ? []
      : [{ active: true, tabId: activeTabId, url: active }]),
    ...tabs.filter((tab) => tab !== null),
  ].slice(0, BROWSER_CONTROL_LIMITS.tabs);
};

/** The tab's frames a read pages through: the top frame first, then by frame id. */
const listReaderFrames = async (tabId: number): Promise<ReaderFrame[]> => {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  return frames
    .filter(({ errorOccurred }) => !errorOccurred)
    .map(({ documentId, frameId }) => ({ documentId, frameId }))
    .toSorted((left, right) => left.frameId - right.frameId)
    .slice(0, BROWSER_CONTROL_LIMITS.frames);
};

/** What every read-only page operation carries. */
const readOperationBase = (
  signIn: SignInPolicy,
  requiredOrigin: string | undefined,
) => ({
  ...(requiredOrigin === undefined
    ? {}
    : { expectedTopOrigin: requiredOrigin }),
  identityProviderHosts: IDENTITY_PROVIDER_HOSTS,
  limits: BROWSER_CONTROL_LIMITS,
  metadataType: BROWSER_CONTROL_TARGET_METADATA,
  shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
  signIn,
  signInPolicies: SIGN_IN_POLICY,
});

/**
 * Runs a read in one frame's document, by the id the frame list gave. A
 * subframe that cannot be reached (gone, or without host access) is passed
 * over; the top frame's failure fails the command.
 */
const runInFrame = async (
  tabId: number,
  frame: ReaderFrame,
  operation: PageOperation & InjectableArgument,
): Promise<unknown> => {
  try {
    const results = await runPageOperation(
      { documentIds: [frame.documentId], tabId },
      operation,
    );
    return results.at(0)?.result;
  } catch (error) {
    if (frame.frameId === TOP_FRAME_ID) {
      throw error;
    }
    return undefined;
  }
};

/**
 * A frame's answer, held to the origin policy: a subframe outside it is
 * passed over unread. The top frame's address is checked by the caller,
 * which refuses the whole read.
 */
const frameOutcome = <T extends { origin: string; url: string }>(
  frame: ReaderFrame,
  result: unknown,
  schema: v.GenericSchema<unknown, T>,
): FrameOutcome<T> => {
  const refusal = v.safeParse(pageRefusalSchema, result);
  if (refusal.success) {
    return { reason: refusal.output.refused, type: "refused" };
  }
  // No answer: a subframe Chrome could not reach.
  if (result === undefined) {
    return { type: "skipped" };
  }
  const parsed = v.safeParse(schema, result);
  if (!parsed.success) {
    return { type: "invalid" };
  }
  if (
    frame.frameId !== TOP_FRAME_ID &&
    !isControllableFrame({
      isTopFrame: false,
      origin: parsed.output.origin,
      url: parsed.output.url,
    })
  ) {
    return { type: "skipped" };
  }
  return { result: parsed.output, type: "read" };
};

const STALE_CURSOR_MESSAGE =
  "The page changed since this cursor was issued. Call snapshot without a cursor, or find, to read it again.";

/** A read that could not start, or a frame that refused it. */
const readRefusal = (
  outcome: PageReadFailure,
  requiredOrigin: ReadSnapshotOptions["requiredOrigin"],
): BrowserControlResult => {
  if (outcome.type === "invalid-cursor") {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      "This cursor is not one a read of this page issued. Use a cursor from the latest snapshot or find result.",
    );
  }
  if (outcome.type === "stale-cursor") {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
      STALE_CURSOR_MESSAGE,
    );
  }
  if (outcome.type === "unreadable-page") {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page returned a read outside the protocol bounds.",
    );
  }
  switch (outcome.reason) {
    case "sign-in":
      return needsMember();
    case "stale-cursor":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
        STALE_CURSOR_MESSAGE,
      );
    case "top-origin":
      return (
        requiredOrigin?.refusal ??
        browserControlError(
          BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
          UNSUPPORTED_PAGE_MESSAGE,
        )
      );
    default:
      outcome.reason satisfies never;
      return panic("Unhandled page refusal");
  }
};

/**
 * Whether the top document that was read may be returned: the tab URL was
 * checked before injection, but the page may have navigated since.
 */
const topDocumentRefusal = (
  top: { origin: string; url: string },
  signIn: SignInPolicy,
  requiredOrigin: ReadSnapshotOptions["requiredOrigin"],
): BrowserControlResult | null => {
  if (requiredOrigin !== undefined && top.origin !== requiredOrigin.origin) {
    return requiredOrigin.refusal;
  }
  if (
    signIn === SIGN_IN_POLICY.handToMember &&
    isIdentityProviderUrl(top.url)
  ) {
    return needsMember();
  }
  return isControllableFrame({
    isTopFrame: true,
    origin: top.origin,
    url: top.url,
  })
    ? null
    : browserControlError(
        BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
        UNSUPPORTED_PAGE_MESSAGE,
      );
};

/** Checks every read does before it touches the page. */
const readPreflight = async (
  tabId: number,
  signIn: SignInPolicy,
): Promise<BrowserControlResult | ReaderFrame[]> => {
  const handsSignInToMember = signIn === SIGN_IN_POLICY.handToMember;
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === undefined || parseControllableUrl(tab.url) === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
      UNSUPPORTED_PAGE_MESSAGE,
    );
  }
  if (handsSignInToMember && isIdentityProviderUrl(tab.url)) {
    return needsMember();
  }
  // Every frame is checked before any is read: a frame without a sign-in
  // is never read for a tab another frame hands to the member. Each frame
  // checks again as it reads, for a sign-in that appears in between.
  if (handsSignInToMember && (await tabAsksForSignIn(tabId))) {
    return needsMember();
  }
  const frames = await listReaderFrames(tabId);
  if (frames.at(0)?.frameId !== TOP_FRAME_ID) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "Chrome could not say which document the tab shows. Take a snapshot again.",
    );
  }
  return frames;
};

type ReadSnapshotOptions = {
  controllerId: string;
  /** Where the window starts; absent reads from the first block in view. */
  cursor?: string;
  /**
   * The only origin the page may be read on, and what to return otherwise.
   * The page refuses before reading anything, and nothing is stored.
   */
  requiredOrigin?: { origin: string; refusal: BrowserControlResult };
  signIn: SignInPolicy;
  tabId: number;
};

const readSnapshot = async ({
  controllerId,
  cursor,
  requiredOrigin,
  signIn,
  tabId,
}: ReadSnapshotOptions): Promise<BrowserControlResult> => {
  const frames = await readPreflight(tabId, signIn);
  if (!Array.isArray(frames)) {
    return frames;
  }
  const outcome = await readPageWindow({
    cursor,
    frames,
    readFrame: async (frame, request) =>
      frameOutcome(
        frame,
        await runInFrame(tabId, frame, {
          ...readOperationBase(signIn, requiredOrigin?.origin),
          facts: request.facts,
          idPrefix: request.idPrefix,
          kind: "snapshot",
          pageControls: request.pageControls,
          purpose: SNAPSHOT_PURPOSE.read,
          purposes: SNAPSHOT_PURPOSE,
          ...(request.read === undefined ? {} : { read: request.read }),
        }),
        frameReadSchema,
      ),
  });
  // A sign-in in any frame, or a top document that turned out to be an
  // identity provider's, is the member's: nothing is returned or stored.
  if (outcome.type !== "window") {
    return readRefusal(outcome, requiredOrigin);
  }
  const { window } = outcome;
  const refusal = topDocumentRefusal(window.top, signIn, requiredOrigin);
  if (refusal !== null) {
    return refusal;
  }
  const url = window.top.url.slice(0, BROWSER_CONTROL_LIMITS.urlChars);
  const parsed = parseBrowserControlResult({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: window.elements,
      elementsLeftOut: window.elementsLeftOut,
      facts: window.facts,
      revision: crypto.randomUUID(),
      tabId,
      tabs: await listChatTabs(tabId, url),
      text: window.text,
      title: window.top.title.slice(0, BROWSER_CONTROL_LIMITS.titleChars),
      url,
      window: window.window,
    },
    status: "success",
  } satisfies BrowserControlResult);
  if (parsed?.status !== "success") {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page returned a snapshot outside the protocol bounds.",
    );
  }
  const current = await readControlledTabState();
  await writeControlledTabState({
    adopted: current?.adopted ?? false,
    controllerId,
    // Chat has now seen this document: the one this read returned, not
    // whatever the tab shows by the time the read is stored.
    settled: {
      documentId: frames.at(0)?.documentId ?? null,
      url: parsed.snapshot.url,
    },
    snapshot: {
      documents: window.documents,
      revision: parsed.snapshot.revision,
      tabId,
      url: parsed.snapshot.url,
    },
    tabId,
  });
  return parsed;
};

/**
 * Finds text, or lists headings, in the page the controlled tab shows.
 * Read-only: what chat's element refs address stays as the last read left
 * it.
 */
const runFind = async (
  command: Extract<
    BrowserControlCommand,
    { action: typeof BROWSER_CONTROL_ACTION.find }
  >,
  { signIn, tabId }: { signIn: SignInPolicy; tabId: number },
): Promise<BrowserControlResult> => {
  const frames = await readPreflight(tabId, signIn);
  if (!Array.isArray(frames)) {
    return frames;
  }
  const outcome = await findInPage({
    after: command.after,
    findFrame: async (frame, request: FindRequest) =>
      frameOutcome(
        frame,
        await runInFrame(tabId, frame, {
          ...readOperationBase(signIn, undefined),
          find: request,
          kind: "find",
        }),
        frameFoundSchema,
      ),
    frames,
    search: command.search,
  });
  if (outcome.type !== "found") {
    return readRefusal(outcome, undefined);
  }
  const topFrame = frames.at(0);
  const top =
    outcome.top ??
    (topFrame === undefined
      ? null
      : await readTopPage(tabId, topFrame, signIn));
  if (top === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page could not be read.",
    );
  }
  if ("status" in top) {
    return top;
  }
  const refusal = topDocumentRefusal(top, signIn, undefined);
  if (refusal !== null) {
    return refusal;
  }
  const parsed = parseBrowserControlResult({
    found: {
      ...outcome.found,
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      tabId,
      title: top.title.slice(0, BROWSER_CONTROL_LIMITS.titleChars),
      url: top.url.slice(0, BROWSER_CONTROL_LIMITS.urlChars),
    },
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "found",
  } satisfies BrowserControlResult);
  return (
    parsed ??
    browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page returned find results outside the protocol bounds.",
    )
  );
};

/** The top document's address and title, read without any of its text. */
const readTopPage = async (
  tabId: number,
  frame: ReaderFrame,
  signIn: SignInPolicy,
): Promise<
  BrowserControlResult | { origin: string; title: string; url: string }
> => {
  const outcome = frameOutcome(
    frame,
    await runInFrame(tabId, frame, {
      ...readOperationBase(signIn, undefined),
      facts: false,
      idPrefix: "",
      kind: "snapshot",
      pageControls: 0,
      purpose: SNAPSHOT_PURPOSE.read,
      purposes: SNAPSHOT_PURPOSE,
    }),
    frameReadSchema,
  );
  switch (outcome.type) {
    case "read":
      return outcome.result;
    case "refused":
      return readRefusal(outcome, undefined);
    case "skipped":
    case "invalid":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.executionFailed,
        "The page could not be read.",
      );
    default:
      outcome satisfies never;
      return panic("Unhandled frame outcome");
  }
};

/**
 * Reads the page after a dispatched action or back navigation. The action
 * may already have taken effect, so every failure here is `outcome-unknown`,
 * and a snapshot that raced a navigation is retaken once the page settles.
 */
const readOutcome = async (
  navigation: TabNavigationObserver,
  tabId: number,
  { controllerId, signal, signIn }: CommandRun,
): Promise<BrowserControlResult> => {
  for (let attempt = 0; attempt < OUTCOME_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const settled = await navigation.waitForSettled(signal);
    if (isStopped(signal)) {
      return outcomeUnknown(STOPPED_AFTER_DISPATCH);
    }
    if (!settled) {
      return outcomeUnknown(
        "The page did not finish loading after the action.",
      );
    }
    const generation = navigation.generation();
    let result: BrowserControlResult | null;
    try {
      result = await readSnapshot({
        controllerId,
        signIn,
        tabId,
      });
    } catch {
      result = null;
    }
    if (navigation.generation() !== generation) {
      continue;
    }
    // The action led to a sign-in: what happened is known, and the page
    // is the member's.
    if (
      result?.status === "success" ||
      (result?.status === "error" &&
        result.code === BROWSER_CONTROL_ERROR_CODE.needsMember)
    ) {
      return result;
    }
    if (result?.status === "error") {
      return outcomeUnknown(
        `The page after the action could not be read: ${result.message}`,
      );
    }
    return outcomeUnknown("Chrome could not read the page after the action.");
  }
  return outcomeUnknown("The page kept navigating after the action.");
};

export type AdoptControlledTabResult =
  | { status: "adopted"; tabId: number; url: string }
  | { status: "unsupported-page" };

/**
 * Makes a tab the user already has open the controlled tab, so chat can read
 * and act on it without re-navigating. Same origin policy and containment as
 * a tab opened by `open`; a tab stella runs in is never adopted, even after
 * it navigated elsewhere.
 */
export const adoptControlledTab = async (
  controllerId: string,
  tab: chrome.tabs.Tab,
  /** Takes the browser back for this connection, once the tab qualifies. */
  takeOver: (() => Promise<void>) | null,
): Promise<AdoptControlledTabResult> => {
  const [controller, stellaTabs] = await Promise.all([
    readBrowserController(),
    readStellaTabs(),
  ]);
  if (
    controller?.controllerId !== controllerId ||
    tab.id === undefined ||
    stellaTabs.has(tab.id) ||
    tab.url === undefined ||
    parseControllableUrl(tab.url) === null
  ) {
    return { status: "unsupported-page" };
  }
  if (takeOver !== null) {
    await takeOver();
  }
  // The user's hand-over always succeeds: at chat's tab limit the oldest of
  // chat's other tabs stays confined but is no longer chat's.
  await containControlledTab(tab.id, { adopted: true, atLimit: "drop-oldest" });
  await writeControlledTabState({
    adopted: true,
    controllerId,
    settled: null,
    snapshot: null,
    tabId: tab.id,
  });
  return { status: "adopted", tabId: tab.id, url: tab.url };
};

type OpenedControlledTab =
  | { status: "cancelled" }
  | { loaded: boolean; status: "navigated"; tabId: number }
  | { status: "navigation-refused" }
  | { status: "over-limit" }
  | { status: "unavailable" };

/**
 * Points the controlled tab, or with `newTab` a tab created for it, at an
 * approved URL. A new tab starts at `about:blank` so the containment rules
 * are in place before it requests anything; the tab controlled until then
 * stays contained beside it as one of chat's tabs.
 */
const openControlledTab = async (
  controllerId: string,
  url: URL,
  { newTab, signal }: { newTab: boolean; signal: AbortSignal },
): Promise<OpenedControlledTab> => {
  const existing = await readControlledTab(controllerId);
  const reused = newTab ? null : existing;
  const tabId =
    reused?.tab.id ??
    (await chrome.tabs.create({ active: true, url: "about:blank" })).id;
  if (tabId === undefined) {
    return { status: "unavailable" };
  }
  // Not yet chat's: the tab Chrome just created is confined as unknown, and
  // nothing else changed.
  const closeCreatedTab = async (): Promise<void> => {
    await forgetContainedTab(tabId);
    await chrome.tabs.remove(tabId).catch(() => undefined);
  };
  // A tab created for this command that did not navigate holds nothing;
  // closing it hands control back to the tab chat had, but only while that
  // tab is still chat's: one the user navigated or that closed meanwhile is
  // not taken back, and no tab is left controlled. Either way no controlled
  // tab is one chat has never read.
  const discardCreatedTab = async (): Promise<void> => {
    if (reused !== null) {
      return;
    }
    const restored =
      existing === null ? null : await switchContainedTab(existing.state.tabId);
    if (existing !== null && restored?.status === "switched") {
      await writeControlledTabState({
        ...existing.state,
        adopted: restored.adopted,
      });
    } else {
      await chrome.storage.session.remove(BROWSER_CONTROLLED_TAB_STORAGE_KEY);
    }
    await closeCreatedTab();
  };
  if (isStopped(signal)) {
    if (reused === null) {
      await closeCreatedTab();
    }
    return { status: "cancelled" };
  }
  // Checked again where the tab joins chat's: a tab a page opened since the
  // caller's check may have taken the last place.
  if ((await containControlledTab(tabId)) === "over-limit") {
    await closeCreatedTab();
    return { status: "over-limit" };
  }
  await writeControlledTabState({
    adopted: reused?.state.adopted ?? false,
    controllerId,
    settled: reused?.state.settled ?? null,
    snapshot: null,
    tabId,
  });
  if (isStopped(signal)) {
    await discardCreatedTab();
    return { status: "cancelled" };
  }
  const navigation = createTabNavigationObserver(tabId);
  try {
    const navigated = await Result.tryPromise(
      async () =>
        await chrome.tabs.update(tabId, { active: true, url: url.href }),
    );
    if (Result.isError(navigated)) {
      // Chrome refused the navigation, so the page never loaded: a new tab
      // is discarded as if stopped.
      await discardCreatedTab();
      return { status: "navigation-refused" };
    }
    return {
      loaded: await navigation.waitForNavigation(signal),
      status: "navigated",
      tabId,
    };
  } finally {
    navigation.dispose();
  }
};

type ExecuteBrowserCommandOptions = {
  /** Charged right before the command acts; refunded if the page refuses. */
  budget: CommandBudget;
  /** The tab and snapshot the web client last saw a result for. */
  observedTab: BrowserObservedTab | null;
  /** Aborts when chat stops the command or control changes. */
  signal: AbortSignal;
  /** How a page that asks for a sign-in is treated; set by the transport. */
  signIn: SignInPolicy;
  /**
   * For an `open` by a controller that does not hold the browser: hands it
   * over, run once every check of the open passed and right before the tab
   * changes. `null` when the controller holds it already.
   */
  takeOver: (() => Promise<void>) | null;
};

/** The tab's top document now; see `TopDocument`. */
/** The tab's top document now, as Chrome's navigation records have it; null when Chrome cannot say. */
const readTopDocument = async (
  tabId: number,
): Promise<LiveTopDocument | null> => {
  const frame = await chrome.webNavigation
    .getFrame({ frameId: TOP_FRAME_ID, tabId })
    .catch(() => null);
  return frame === null
    ? null
    : {
        documentId: frame.documentId,
        url: frame.url.slice(0, BROWSER_CONTROL_LIMITS.urlChars),
      };
};

const budgetExceeded = (message: string): BrowserControlResult =>
  browserControlError(BROWSER_CONTROL_ERROR_CODE.budgetExceeded, message);

const IDENTITY_REFUSALS = {
  "page-unconfirmed": browserControlError(
    BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
    "stella cannot confirm the tab still shows the page it last read, so it will not navigate away from it. Take a snapshot and try again. If the page cannot be read, for example an error page, ask the user to open a page in that tab themselves or to hand over another tab from the extension popup.",
  ),
  "stale-snapshot": browserControlError(
    BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
    "The page changed after this browser action was proposed. Take a new snapshot before acting.",
  ),
  "tab-changed": browserControlError(
    BROWSER_CONTROL_ERROR_CODE.tabChanged,
    "The controlled tab changed since stella last read it. Take a snapshot of the current tab before navigating or acting.",
  ),
} as const satisfies Record<string, BrowserControlResult>;

const identityRefusal = (
  status: keyof typeof IDENTITY_REFUSALS,
): BrowserControlResult => IDENTITY_REFUSALS[status];

export const executeBrowserCommand = async (
  controllerId: string,
  command: BrowserControlCommand,
  options: ExecuteBrowserCommandOptions,
): Promise<BrowserControlResult> => {
  const progress = { dispatched: false };
  return await runBrowserCommand(controllerId, command, options, progress);
};

type ControlledTab = NonNullable<Awaited<ReturnType<typeof readControlledTab>>>;

/**
 * `dispatched` is set once a click, fill, select, key press or navigation
 * has been handed to the page or tab; from then on a failure cannot say it
 * did not run.
 */
type CommandProgress = { dispatched: boolean };

type CommandRun = Pick<
  ExecuteBrowserCommandOptions,
  "budget" | "signal" | "signIn" | "takeOver"
> & {
  controllerId: string;
  progress: CommandProgress;
};

/** Whether the command still addresses the tab and page chat last saw. */
const readCommandIdentity = async (
  command: BrowserControlCommand,
  controlledTab: ControlledTab | null,
  observedTab: BrowserObservedTab | null,
) => {
  const tabId = controlledTab?.tab.id;
  // Only these move the controlled tab away from the page it shows.
  const isNavigation =
    (command.action === BROWSER_CONTROL_ACTION.open &&
      command.newTab !== true) ||
    command.action === BROWSER_CONTROL_ACTION.goBack;
  return checkCommandIdentity({
    command,
    controlledTab:
      controlledTab === null || tabId === undefined
        ? null
        : {
            adopted: controlledTab.state.adopted,
            tabId,
            url: controlledTab.tab.url,
          },
    ...(isNavigation && controlledTab !== null && tabId !== undefined
      ? {
          navigation: {
            live: await readTopDocument(tabId),
            settled: controlledTab.state.settled,
          },
        }
      : {}),
    observedTab,
    snapshot: controlledTab?.state.snapshot ?? null,
  });
};

const runOpen = async (
  command: Extract<
    BrowserControlCommand,
    { action: typeof BROWSER_CONTROL_ACTION.open }
  >,
  { budget, controllerId, progress, signal, signIn, takeOver }: CommandRun,
): Promise<BrowserControlResult> => {
  const requested = parseControllableUrl(command.url);
  if (requested === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.navigationFailed,
      "Only public HTTPS pages without embedded credentials can be opened; stella itself and intranet, loopback and private addresses are refused.",
    );
  }
  const newTab = command.newTab === true;
  const tabLimitReached = (): BrowserControlResult =>
    browserControlError(
      BROWSER_CONTROL_ERROR_CODE.tabLimitReached,
      `Chat already has ${BROWSER_CONTROL_LIMITS.tabs} tabs open, the most it may keep. Switch to one of them with switch-tab, or open the page in the current tab without newTab.`,
    );
  // Spares creating a tab only to close it; the limit itself holds where
  // the tab joins chat's.
  // A takeover's new holder keeps none of the previous holder's tabs: the
  // limit then holds where the tab joins.
  if (
    newTab &&
    takeOver === null &&
    chatTabsAtLimit(await readContainedTabs())
  ) {
    return tabLimitReached();
  }
  const overBudget = await budget.charge();
  if (overBudget !== null) {
    return budgetExceeded(overBudget);
  }
  // Nothing refused the page: only now may the browser change hands.
  if (takeOver !== null) {
    if (isStopped(signal)) {
      await budget.refund();
      return cancelled();
    }
    await takeOver();
  }
  progress.dispatched = true;
  const opened = await openControlledTab(controllerId, requested, {
    newTab,
    signal,
  });
  if (opened.status === "cancelled") {
    await budget.refund();
    return cancelled();
  }
  if (opened.status === "over-limit") {
    await budget.refund();
    return tabLimitReached();
  }
  if (opened.status === "navigation-refused") {
    await budget.refund();
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.navigationFailed,
      "Chrome refused to open this page in the tab; nothing was loaded.",
    );
  }
  if (opened.status === "unavailable") {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.navigationFailed,
      "Chrome could not create a tab for this page.",
    );
  }
  if (isStopped(signal)) {
    return outcomeUnknown(STOPPED_AFTER_DISPATCH);
  }
  if (!opened.loaded) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.timedOut,
      "The page did not finish loading in time.",
    );
  }
  // The user approved the requested origin, not wherever it redirected.
  // Reading the landing page needs its own approved snapshot.
  const landed = await chrome.tabs.get(opened.tabId);
  const landedUrl =
    landed.url === undefined ? null : parseControllableUrl(landed.url);
  if (
    signIn === SIGN_IN_POLICY.handToMember &&
    landedUrl !== null &&
    isIdentityProviderUrl(landedUrl.href)
  ) {
    return needsMember();
  }
  if (landedUrl === null || landedUrl.origin !== requested.origin) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.redirected,
      `The page redirected away from ${requested.origin} to ${landedUrl?.origin ?? "an unsupported address"} and was not read. Use snapshot to read it after approval.`,
    );
  }
  // The tab now shows the page chat opened, whatever the user had navigated
  // it to before. Its own commit was a plain link, which never counts as
  // the user's, so this runs after it and a later user commit still counts.
  await reclaimControlledTab(opened.tabId);
  return await readSnapshot({
    controllerId,
    signIn,
    tabId: opened.tabId,
  });
};

const runGoBack = async (
  tabId: number,
  state: ControlledTabState,
  run: CommandRun,
): Promise<BrowserControlResult> => {
  const { budget, progress, signal } = run;
  const navigation = createTabNavigationObserver(tabId);
  try {
    const overBudget = await budget.charge();
    if (overBudget !== null) {
      return budgetExceeded(overBudget);
    }
    await forgetSnapshot(state);
    if (isStopped(signal)) {
      await budget.refund();
      return cancelled();
    }
    progress.dispatched = true;
    await navigateBack(tabId);
    return await readOutcome(navigation, tabId, run);
  } finally {
    navigation.dispose();
  }
};

/** What the user had in front before a tab was shown, to put back. */
type Foreground = {
  /** The window that had focus; null when none did. */
  focusedWindowId: number | null;
  /** The tab that was active in the shown tab's window. */
  tabId: number | null;
};

/**
 * Makes the tab active in its window and focuses that window, after noting
 * what was in front. Any failure, reading or showing, fails the whole step.
 */
const showTab = async (tabId: number, windowId: number) =>
  await Result.tryPromise(async (): Promise<Foreground> => {
    const [active, focused] = await Promise.all([
      chrome.tabs.query({ active: true, windowId }),
      chrome.windows.getLastFocused(),
    ]);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
    return {
      focusedWindowId: focused.focused ? (focused.id ?? null) : null,
      tabId: active.at(0)?.id ?? null,
    };
  });

/** Puts back the tab and window focus `showTab` found. */
const restoreForeground = async ({ focusedWindowId, tabId }: Foreground) =>
  await Result.tryPromise(async () => {
    if (tabId !== null) {
      await chrome.tabs.update(tabId, { active: true });
    }
    if (focusedWindowId !== null) {
      await chrome.windows.update(focusedWindowId, { focused: true });
    }
  });

/** What makes a tab chat's to switch to: who opened it, never a listing. */
const NOT_A_CHAT_TAB =
  "That tab is not one of chat's tabs. Chat may switch only to a tab it controlled before, or one a page in its tabs opened, that the user has not navigated themselves since. Open the page instead.";

/**
 * Hands control to another of chat's tabs: one chat controlled before, or
 * one a page in chat's tabs opened, unless the user navigated it since. A
 * stella tab, a tab of the user's, one only confined and a tab of unknown
 * owner are refused. The tab must still be on the origin the
 * user approved, both before control moves and in the page then read.
 */
const runSwitchTab = async (
  command: Extract<
    BrowserControlCommand,
    { action: typeof BROWSER_CONTROL_ACTION.switchTab }
  >,
  { budget, controllerId, signal, signIn }: CommandRun,
): Promise<BrowserControlResult> => {
  const { tabId } = command;
  const [owner, stellaTabs] = await Promise.all([
    readTabOwner(tabId),
    readStellaTabs(),
  ]);
  if ((owner !== "controlled" && owner !== "chat") || stellaTabs.has(tabId)) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.tabChanged,
      NOT_A_CHAT_TAB,
    );
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.tabClosed,
      "That tab was closed. Switch to another of chat's tabs or open the page.",
    );
  }
  const approved = parseControllableUrl(command.url);
  const current = tab.url === undefined ? null : parseControllableUrl(tab.url);
  if (approved === null || current === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
      UNSUPPORTED_PAGE_MESSAGE,
    );
  }
  const leftApprovedOrigin = (): BrowserControlResult =>
    browserControlError(
      BROWSER_CONTROL_ERROR_CODE.tabChanged,
      `That tab no longer shows ${approved.origin} and was not read. Take a snapshot for chat's tabs and their current addresses.`,
    );
  if (current.origin !== approved.origin) {
    return leftApprovedOrigin();
  }
  const overBudget = await budget.charge();
  if (overBudget !== null) {
    return budgetExceeded(overBudget);
  }
  if (isStopped(signal)) {
    await budget.refund();
    return cancelled();
  }
  // The user sees the tab chat will operate, as with `open`: active in its
  // window, and that window focused. It comes to the front before anything
  // is committed, so a tab Chrome cannot show changes nothing.
  const shown = await showTab(tabId, tab.windowId);
  if (Result.isError(shown)) {
    await budget.refund();
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "Chrome could not bring that tab to the front, so control stayed where it was. Take a snapshot to see chat's tabs.",
    );
  }
  if (isStopped(signal)) {
    // Control never moved, so what the user saw before comes back too.
    if (Result.isError(await restoreForeground(shown.value))) {
      return outcomeUnknown(
        "The tab was brought to the front, and Chrome could not put the previous one back; control stayed on the tab chat had.",
      );
    }
    await budget.refund();
    return cancelled();
  }
  // Containment moves first: it re-checks the tab is chat's in the same step,
  // and nothing else needs undoing when it refuses. Should the worker stop
  // before the second write, the stored controlled tab is still the old one,
  // with the snapshot the web client last saw: it is confined and chat's,
  // so the next command acts where chat expects, and nothing the user owns
  // is reached.
  const switched = await switchContainedTab(tabId);
  if (switched.status === "refused") {
    await budget.refund();
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.tabChanged,
      NOT_A_CHAT_TAB,
    );
  }
  const previous = await readControlledTabState();
  if (previous?.controllerId !== controllerId || previous.tabId !== tabId) {
    await writeControlledTabState({
      // A tab the user handed over keeps the stricter checks that go with it.
      adopted: switched.adopted,
      controllerId,
      settled: null,
      snapshot: null,
      tabId,
    });
  }
  // Control has moved; the web client still knows the old tab, so a stop
  // from here on asks it to read the page before anything else.
  if (isStopped(signal)) {
    return outcomeUnknown(STOPPED_AFTER_DISPATCH);
  }
  // Read only on the approved origin: a page that left it in the meantime
  // refuses before anything is read, and nothing is stored.
  return await readSnapshot({
    controllerId,
    requiredOrigin: { origin: approved.origin, refusal: leftApprovedOrigin() },
    signIn,
    tabId,
  });
};

/**
 * Whether any frame of the tab asks for a sign-in now. A desktop action
 * checks the whole tab before it acts: a sign-in frame that appeared after
 * the last read must stop the action, not only the read that follows it.
 */
const tabAsksForSignIn = async (tabId: number): Promise<boolean> => {
  const results = await runPageOperation(
    { allFrames: true, tabId },
    {
      ...readOperationBase(SIGN_IN_POLICY.handToMember, undefined),
      facts: false,
      idPrefix: "",
      kind: "snapshot",
      pageControls: 0,
      purpose: SNAPSHOT_PURPOSE.signInCheck,
      purposes: SNAPSHOT_PURPOSE,
    },
  );
  return results.some(({ result }) => v.is(signInRefusalSchema, result));
};

type ElementActionArgs = {
  command: BrowserControlElementCommand;
  controlledTab: ControlledTab & { tabId: number };
  /** The document the element's frame showed when the page was read. */
  documentId: string | null;
  run: CommandRun;
};

const runElementAction = async ({
  command,
  controlledTab: { state, tab, tabId },
  documentId,
  run,
}: ElementActionArgs): Promise<BrowserControlResult> => {
  const { budget, progress, signal, signIn } = run;
  if (tab.url === undefined || parseControllableUrl(tab.url) === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
      UNSUPPORTED_PAGE_MESSAGE,
    );
  }
  const reference = parseElementReference(command.target.ref);
  if (!reference || documentId === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      "The element reference is malformed.",
    );
  }
  const frame = await checkActionFrame(tabId, reference.frameId, documentId);
  if (!frame.ok) {
    return frame.error;
  }
  if (
    signIn === SIGN_IN_POLICY.handToMember &&
    (await tabAsksForSignIn(tabId))
  ) {
    return needsMember();
  }
  const overBudget = await budget.charge();
  if (overBudget !== null) {
    return budgetExceeded(overBudget);
  }
  const navigation = createTabNavigationObserver(tabId);
  try {
    await forgetSnapshot(state);
    if (isStopped(signal)) {
      await budget.refund();
      return cancelled();
    }
    progress.dispatched = true;
    const outcome = await injectDomAction({
      command,
      documentId,
      expectedOrigin: frame.origin,
      path: reference.path,
      signIn,
      tabId,
    });
    if (outcome.status === "refused") {
      // The page refused before acting, so the snapshot still describes it
      // and nothing was spent.
      await writeControlledTabState(state);
      await budget.refund();
      return browserControlError(outcome.code, outcome.error);
    }
    if (outcome.status === "unobserved") {
      return outcomeUnknown(
        "Chrome lost the page before the action reported back.",
      );
    }
    return await readOutcome(navigation, tabId, run);
  } finally {
    navigation.dispose();
  }
};

const runBrowserCommand = async (
  controllerId: string,
  command: BrowserControlCommand,
  {
    budget,
    observedTab,
    signal,
    signIn,
    takeOver,
  }: ExecuteBrowserCommandOptions,
  progress: CommandProgress,
): Promise<BrowserControlResult> => {
  const run = {
    budget,
    controllerId,
    progress,
    signal,
    signIn,
    takeOver,
  };
  try {
    if (isStopped(signal)) {
      return cancelled();
    }
    const controlledTab = await readControlledTab(controllerId);
    const identity = await readCommandIdentity(
      command,
      controlledTab,
      observedTab,
    );
    if (identity.status !== "ok") {
      return identityRefusal(identity.status);
    }
    if (command.action === BROWSER_CONTROL_ACTION.open) {
      return await runOpen(command, run);
    }
    if (command.action === BROWSER_CONTROL_ACTION.switchTab) {
      return await runSwitchTab(command, run);
    }
    if (!controlledTab) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.noControlledTab,
        "No tab is under chat's control. Open a page, or switch to one of chat's tabs listed in the latest snapshot.",
      );
    }
    const tabId = controlledTab.tab.id;
    if (tabId === undefined) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.tabClosed,
        "The controlled Chrome tab is no longer available.",
      );
    }
    if (command.action === BROWSER_CONTROL_ACTION.snapshot) {
      return await readSnapshot({
        controllerId,
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        signIn,
        tabId,
      });
    }
    if (command.action === BROWSER_CONTROL_ACTION.find) {
      return await runFind(command, { signIn, tabId });
    }
    if (command.action === BROWSER_CONTROL_ACTION.goBack) {
      return await runGoBack(tabId, controlledTab.state, run);
    }
    return await runElementAction({
      command,
      controlledTab: { ...controlledTab, tabId },
      documentId: identity.documentId,
      run,
    });
  } catch {
    if (progress.dispatched) {
      return outcomeUnknown(
        "Chrome could not observe the page after the action.",
      );
    }
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "Chrome could not run this action on the current page. Error pages and blocked file downloads cannot be read; open another page or go back.",
    );
  }
};

import * as v from "valibot";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  type BROWSER_CONTROL_KEYS,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  ELEMENT_REFERENCE_SHADOW_SEGMENT,
  type BrowserControlCommand,
  type BrowserControlElementCommand,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  type BrowserObservedTab,
  parseBrowserControlResult,
  parseElementReference,
} from "@stll/api-contract/browser-control";

import { browserControlError } from "./browser-control-result";
import { readBrowserController } from "./controller";
import { isControllableFrame, parseControllableUrl } from "./origin-policy";
import { checkCommandIdentity, type SnapshotState } from "./snapshot-guard";
import { frameSnapshotSchema, mergeFrameSnapshots } from "./snapshot-merge";
import { BROWSER_CONTROLLED_TAB_STORAGE_KEY } from "./storage-keys";
import { containControlledTab, forgetContainedTab } from "./tab-containment";

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
  /** Null until the tab is read, and again once an action may have changed it. */
  snapshot: SnapshotState | null;
  tabId: number;
};

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

/** Waits `ms`, or less once `signal` aborts. */
const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      sleep(ms, settled.signal).then(() => false),
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
    await sleep(TAB_STATUS_POLL_MS, signal);
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

type PageOperation =
  | {
      action: BrowserControlElementCommand;
      errorCode: typeof BROWSER_CONTROL_ERROR_CODE;
      /** The frame origin the worker checked; the action refuses any other. */
      expectedOrigin: string;
      kind: "action";
      limits: typeof BROWSER_CONTROL_LIMITS;
      path: string;
      shadowSegment: typeof ELEMENT_REFERENCE_SHADOW_SEGMENT;
    }
  | { kind: "locate" }
  | {
      kind: "snapshot";
      limits: typeof BROWSER_CONTROL_LIMITS;
      shadowSegment: typeof ELEMENT_REFERENCE_SHADOW_SEGMENT;
    };

/**
 * The one script injected into a frame of the controlled tab. Chrome
 * serializes `func`, so every DOM helper lives inside it; all operations
 * share this single copy. Element paths are frame-local; the worker qualifies
 * them with the frame id. Every operation reports or checks the frame's
 * origin, which the worker holds to the origin policy.
 */
const runPageOperation = async (
  injectionTarget: chrome.scripting.InjectionTarget,
  operation: PageOperation,
) =>
  await chrome.scripting.executeScript({
    args: [operation],
    func: (pageOperation) => {
      if (pageOperation.kind === "locate") {
        return { origin: window.origin, url: window.location.href };
      }
      const { limits, shadowSegment } = pageOperation;
      const SKIPPED_TAGS = new Set(["NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);
      const normalize = (value: string) =>
        value.replaceAll(/\s+/gu, " ").trim();
      const visible = (element: Element) => {
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (style.display === "contents" || element.getClientRects().length > 0)
        );
      };
      // `-webkit-text-security` is how pages mask secrets outside
      // type=password; it is inherited, so masked descendants count too.
      const masked = (element: Element) => {
        const security = window
          .getComputedStyle(element)
          .getPropertyValue("-webkit-text-security");
        return security !== "" && security !== "none";
      };
      const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
        "current-password",
        "new-password",
        "one-time-code",
      ]);
      const SECRET_FIELD_NAME =
        /pass(?:word|wd|code|phrase)|pwd|one-?time|otp|cvc|cvv/iu;
      // A field once seen as secret stays secret for the life of its
      // document, so a "show password" toggle that turns type=password into
      // text does not make the value readable. The extension's isolated world
      // keeps this set across injections; the page can neither see nor clear
      // it.
      const HISTORY_KEY = "stellaSensitiveFields";
      const storedHistory: unknown = Reflect.get(globalThis, HISTORY_KEY);
      const sensitiveHistory: WeakSet<Element> =
        storedHistory instanceof WeakSet ? storedHistory : new WeakSet();
      Reflect.set(globalThis, HISTORY_KEY, sensitiveHistory);
      const namedLikeSecret = (element: Element) =>
        (element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement) &&
        (SECRET_FIELD_NAME.test(element.name) ||
          SECRET_FIELD_NAME.test(element.id));
      // Passwords, payment cards and one-time codes: their values and text
      // are never read, and the model may not type or choose them.
      const isSensitiveField = (element: Element) => {
        if (sensitiveHistory.has(element)) {
          return true;
        }
        const sensitive =
          (element instanceof HTMLInputElement &&
            element.type === "password") ||
          (element.getAttribute("autocomplete") ?? "")
            .toLowerCase()
            .split(/\s+/u)
            .some(
              (token) =>
                token.startsWith("cc-") ||
                SENSITIVE_AUTOCOMPLETE_TOKENS.has(token),
            ) ||
          masked(element) ||
          namedLikeSecret(element);
        if (sensitive) {
          sensitiveHistory.add(element);
        }
        return sensitive;
      };
      // Records every field that is secret right now, before anything reads
      // the page or acts on it.
      const rememberSensitiveFields = (root: ParentNode) => {
        for (const element of root.querySelectorAll("*")) {
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          ) {
            isSensitiveField(element);
          }
          if (element.shadowRoot) {
            rememberSensitiveFields(element.shadowRoot);
          }
        }
      };
      rememberSensitiveFields(document);
      // A rect(...) clip or a clip-path that leaves nothing to see.
      const clippedAway = (style: CSSStyleDeclaration) => {
        // Computed as `rect(top, right, bottom, left)`; `auto` edges parse
        // to NaN and never count as collapsed.
        const clip = style.getPropertyValue("clip");
        const edges = clip.startsWith("rect(")
          ? clip
              .slice("rect(".length, -1)
              .split(",")
              .map((edge) => Number.parseFloat(edge))
          : [];
        const [
          top = Number.NaN,
          right = Number.NaN,
          bottom = Number.NaN,
          left = Number.NaN,
        ] = edges;
        if (edges.length === 4 && (right - left <= 1 || bottom - top <= 1)) {
          return true;
        }
        return /^(?:inset\((?:[5-9]\d|\d{3,})%|circle\(0(?:px)?[\s)])/u.test(
          style.clipPath,
        );
      };
      const CLIPPING_OVERFLOW = new Set(["clip", "hidden"]);
      // Content a reader of the rendered page cannot see: hidden from
      // assistive technology, transparent, clipped away, collapsed to a
      // pixel or pushed off the page. Pages hide instructions for AI readers
      // there, so neither its text nor its controls are collected.
      const concealed = (element: Element) => {
        if (element.getAttribute("aria-hidden") === "true") {
          return true;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "contents") {
          return false;
        }
        if (Number.parseFloat(style.opacity) === 0 || clippedAway(style)) {
          return true;
        }
        const rect = element.getBoundingClientRect();
        if (
          (CLIPPING_OVERFLOW.has(style.overflowX) && rect.width <= 1) ||
          (CLIPPING_OVERFLOW.has(style.overflowY) && rect.height <= 1)
        ) {
          return true;
        }
        return (
          (rect.width > 0 || rect.height > 0) &&
          (rect.right + window.scrollX <= 0 ||
            rect.bottom + window.scrollY <= 0)
        );
      };
      // Text inside a visible box that still does not show: zero-size or
      // transparent glyphs, or text indented off the page.
      const TRANSPARENT_COLORS = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
      const concealsText = (element: Element) => {
        const style = window.getComputedStyle(element);
        return (
          style.fontSize === "0px" ||
          Number.parseFloat(style.textIndent) <= -999 ||
          (TRANSPARENT_COLORS.has(style.color) &&
            style.backgroundClip !== "text" &&
            style.getPropertyValue("-webkit-background-clip") !== "text")
        );
      };
      const concealedCache = new Map<Element, boolean>();
      const concealedInTree = (element: Element): boolean => {
        const cached = concealedCache.get(element);
        if (cached !== undefined) {
          return cached;
        }
        const root = element.getRootNode();
        const parent =
          element.parentElement ??
          (root instanceof ShadowRoot ? root.host : null);
        const hidden =
          concealed(element) || (parent !== null && concealedInTree(parent));
        concealedCache.set(element, hidden);
        return hidden;
      };
      const childNodesOf = (element: Element): readonly Node[] => {
        if (element instanceof HTMLSlotElement) {
          const assigned = element.assignedNodes({ flatten: true });
          if (assigned.length > 0) {
            return assigned;
          }
        }
        return [...(element.shadowRoot ?? element).childNodes];
      };
      const collectText = (root: Node, maxChars: number) => {
        const parts: string[] = [];
        let total = 0;
        const stack: Node[] = [root];
        while (total < maxChars) {
          const node = stack.pop();
          if (!node) {
            break;
          }
          if (node instanceof Text) {
            const value = (node.nodeValue ?? "").slice(0, maxChars - total);
            if (value.trim().length > 0) {
              parts.push(value);
              total += value.length;
            }
            continue;
          }
          if (
            !(node instanceof Element) ||
            SKIPPED_TAGS.has(node.tagName) ||
            !visible(node) ||
            concealed(node) ||
            concealsText(node) ||
            isSensitiveField(node)
          ) {
            continue;
          }
          const children = childNodesOf(node);
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) {
              stack.push(child);
            }
          }
        }
        return normalize(parts.join(" "));
      };
      const roleFor = (element: Element) => {
        const explicit = element.getAttribute("role");
        if (explicit) {
          return explicit;
        }
        if (element instanceof HTMLAnchorElement) {
          return "link";
        }
        if (element instanceof HTMLButtonElement) {
          return "button";
        }
        if (element instanceof HTMLSelectElement) {
          return "select";
        }
        if (element instanceof HTMLTextAreaElement) {
          return "textbox";
        }
        if (element instanceof HTMLInputElement) {
          return element.type === "checkbox" || element.type === "radio"
            ? element.type
            : "textbox";
        }
        return "interactive";
      };
      const nameFor = (element: Element) =>
        normalize(
          element.getAttribute("aria-label") ??
            element.getAttribute("title") ??
            element.getAttribute("placeholder") ??
            collectText(element, limits.elementNameChars),
        ).slice(0, limits.elementNameChars);
      const valueFor = (element: Element) => {
        if (
          (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement) &&
          !isSensitiveField(element)
        ) {
          return element.value.slice(0, limits.valueChars);
        }
        return undefined;
      };
      const hrefFor = (element: Element) =>
        element instanceof HTMLAnchorElement && element.href !== ""
          ? element.href.slice(0, limits.urlChars)
          : undefined;
      const isDisabled = (element: Element) =>
        element.matches(":disabled") ||
        element.getAttribute("aria-disabled") === "true";
      // The row, list item or form around a control: identical controls in
      // repeated rows differ only by this text, so it is part of the identity
      // a later action must match.
      const CONTEXT_SELECTOR =
        "tr, li, [role='row'], [role='listitem'], article, fieldset, form, section";
      const contextFor = (element: Element) => {
        const container = element.closest(CONTEXT_SELECTOR);
        if (!container || container === document.body) {
          return undefined;
        }
        const text = collectText(container, limits.contextChars).slice(
          0,
          limits.contextChars,
        );
        return text.length === 0 || text === nameFor(element)
          ? undefined
          : text;
      };
      const focusableSelector =
        "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";
      const moveFocus = (element: HTMLElement) => {
        const focusables = [
          ...document.querySelectorAll(focusableSelector),
        ].filter(
          (candidate): candidate is HTMLElement =>
            candidate instanceof HTMLElement &&
            visible(candidate) &&
            !isDisabled(candidate),
        );
        focusables[focusables.indexOf(element) + 1]?.focus();
      };
      const editValue = (
        element: HTMLElement,
        edit: (value: string) => string,
      ) => {
        if (
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement)
        ) {
          return;
        }
        Reflect.set(
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype,
          "value",
          edit(element.value),
          element,
        );
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const stepSelect = (element: HTMLElement, delta: number) => {
        if (!(element instanceof HTMLSelectElement)) {
          return;
        }
        const next = Math.min(
          Math.max(element.selectedIndex + delta, 0),
          element.options.length - 1,
        );
        if (next === element.selectedIndex) {
          return;
        }
        element.selectedIndex = next;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      // Synthetic KeyboardEvents reach page listeners but never trigger the
      // browser's default action, so each supported key performs it here.
      // A total map rather than a switch: this function is serialized into the
      // page, where panic() is unavailable for an exhaustive default.
      const defaultKeyActions: Record<
        (typeof BROWSER_CONTROL_KEYS)[number],
        (element: HTMLElement) => void
      > = {
        ArrowDown: (element) => stepSelect(element, 1),
        ArrowLeft: (element) => stepSelect(element, -1),
        ArrowRight: (element) => stepSelect(element, 1),
        ArrowUp: (element) => stepSelect(element, -1),
        Backspace: (element) =>
          editValue(element, (value) => value.slice(0, -1)),
        Enter: (element) => {
          if (element instanceof HTMLTextAreaElement) {
            editValue(element, (value) => `${value}\n`);
          } else if (element instanceof HTMLInputElement && element.form) {
            element.form.requestSubmit();
          } else if (
            element instanceof HTMLButtonElement ||
            element instanceof HTMLAnchorElement
          ) {
            element.click();
          }
        },
        Escape: (element) => element.blur(),
        Space: (element) => {
          if (
            element instanceof HTMLButtonElement ||
            (element instanceof HTMLInputElement &&
              (element.type === "checkbox" || element.type === "radio"))
          ) {
            element.click();
          }
        },
        Tab: (element) => moveFocus(element),
      };
      const performDefaultKeyAction = (
        element: HTMLElement,
        key: (typeof BROWSER_CONTROL_KEYS)[number],
      ) => {
        defaultKeyActions[key](element);
      };
      const pathFor = (element: Element) => {
        const segments: string[] = [];
        let current: Element = element;
        while (current !== document.documentElement) {
          const parent = current.parentElement;
          if (parent) {
            segments.push(
              String(Array.prototype.indexOf.call(parent.children, current)),
            );
            current = parent;
            continue;
          }
          const root = current.parentNode;
          if (!(root instanceof ShadowRoot)) {
            return null;
          }
          segments.push(
            String(Array.prototype.indexOf.call(root.children, current)),
            shadowSegment,
          );
          current = root.host;
        }
        return segments.toReversed().join(".");
      };
      const resolveElement = (path: string): Element | null => {
        let container: Element | ShadowRoot = document.documentElement;
        for (const segment of path.split(".")) {
          if (segment === shadowSegment) {
            if (!(container instanceof Element) || !container.shadowRoot) {
              return null;
            }
            container = container.shadowRoot;
            continue;
          }
          const next = container.children.item(Number(segment));
          if (!next) {
            return null;
          }
          container = next;
        }
        return container instanceof Element ? container : null;
      };

      if (pageOperation.kind === "snapshot") {
        const interactiveSelector = [
          "a[href]",
          "button",
          "input",
          "textarea",
          "select",
          "[contenteditable='true']",
          "[role='button']",
          "[role='checkbox']",
          "[role='combobox']",
          "[role='link']",
          "[role='menuitem']",
          "[role='radio']",
          "[role='tab']",
          "[role='textbox']",
        ].join(",");
        const elements: {
          context?: string;
          href?: string;
          name: string;
          path: string;
          role: string;
          value?: string;
        }[] = [];
        const visit = (root: ParentNode) => {
          for (const element of root.querySelectorAll("*")) {
            if (elements.length >= limits.elements) {
              return;
            }
            if (
              element.matches(interactiveSelector) &&
              visible(element) &&
              !isDisabled(element) &&
              !concealedInTree(element)
            ) {
              const path = pathFor(element);
              if (path !== null) {
                const context = contextFor(element);
                const href = hrefFor(element);
                const value = valueFor(element);
                elements.push({
                  name: nameFor(element),
                  path,
                  role: roleFor(element),
                  ...(context === undefined ? {} : { context }),
                  ...(href === undefined ? {} : { href }),
                  ...(value === undefined ? {} : { value }),
                });
              }
            }
            if (element.shadowRoot) {
              visit(element.shadowRoot);
            }
          }
        };
        visit(document);

        return {
          elements,
          origin: window.origin,
          text: collectText(document.body, limits.pageTextTotalChars),
          title: document.title.slice(0, limits.titleChars),
          url: window.location.href.slice(0, limits.urlChars),
        };
      }

      const { action, errorCode } = pageOperation;
      if (window.origin !== pageOperation.expectedOrigin) {
        return {
          code: errorCode.staleSnapshot,
          error: "The frame navigated after the page snapshot.",
          ok: false,
        };
      }
      const target = resolveElement(pageOperation.path);
      if (!target) {
        return {
          error: "The referenced element is no longer on the page.",
          code: errorCode.elementNotFound,
          ok: false,
        };
      }
      if (
        nameFor(target) !== action.target.name ||
        roleFor(target) !== action.target.role ||
        (action.target.href !== undefined &&
          hrefFor(target) !== action.target.href) ||
        (action.target.context !== undefined &&
          contextFor(target) !== action.target.context)
      ) {
        return {
          error: "The referenced element changed after the page snapshot.",
          code: errorCode.staleSnapshot,
          ok: false,
        };
      }
      if (!visible(target) || concealedInTree(target)) {
        return {
          error: "The referenced element is no longer visible on the page.",
          code: errorCode.staleSnapshot,
          ok: false,
        };
      }
      if (isDisabled(target)) {
        return {
          code: errorCode.executionFailed,
          error:
            "The control is disabled; the page does not accept this action.",
          ok: false,
        };
      }
      const sensitiveFieldRefusal = {
        code: errorCode.sensitiveField,
        error:
          "Passwords, payment card details and one-time codes must be entered manually.",
        ok: false,
      } as const;
      const isSensitiveTarget = isSensitiveField(target);

      if (action.action === "click") {
        if (!(target instanceof HTMLElement)) {
          return {
            error: "The referenced element cannot be clicked.",
            code: errorCode.elementNotFound,
            ok: false,
          };
        }
        target.click();
        return { ok: true };
      }

      if (action.action === "fill") {
        if (target instanceof HTMLInputElement) {
          if (target.type === "file") {
            return {
              code: errorCode.executionFailed,
              error: "File inputs are not supported.",
              ok: false,
            };
          }
          if (isSensitiveTarget) {
            return sensitiveFieldRefusal;
          }
          Reflect.set(
            HTMLInputElement.prototype,
            "value",
            action.value,
            target,
          );
        } else if (isSensitiveTarget) {
          return sensitiveFieldRefusal;
        } else if (target instanceof HTMLTextAreaElement) {
          Reflect.set(
            HTMLTextAreaElement.prototype,
            "value",
            action.value,
            target,
          );
        } else if (target instanceof HTMLElement && target.isContentEditable) {
          target.textContent = action.value;
        } else {
          return {
            error: "The referenced element is not editable.",
            code: errorCode.elementNotFound,
            ok: false,
          };
        }
        target.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText" }),
        );
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }

      if (action.action === "select") {
        if (!(target instanceof HTMLSelectElement)) {
          return {
            error: "The referenced element is not a select control.",
            code: errorCode.elementNotFound,
            ok: false,
          };
        }
        if (isSensitiveTarget) {
          return sensitiveFieldRefusal;
        }
        Reflect.set(HTMLSelectElement.prototype, "value", action.value, target);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }

      if (!(target instanceof HTMLElement)) {
        return {
          error: "The referenced element cannot receive a key.",
          code: errorCode.elementNotFound,
          ok: false,
        };
      }
      if (isSensitiveTarget) {
        return sensitiveFieldRefusal;
      }
      target.focus();
      const key = action.key === "Space" ? " " : action.key;
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key }),
      );
      performDefaultKeyAction(target, action.key);
      target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
      return { ok: true };
    },
    target: injectionTarget,
  });

type ActionFrameCheck =
  | { error: BrowserControlResult; ok: false }
  | { ok: true; origin: string };

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

const injectDomAction = async (
  tabId: number,
  documentId: string,
  path: string,
  expectedOrigin: string,
  command: BrowserControlElementCommand,
): Promise<DomActionOutcome> => {
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
        path,
        shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
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

type ReadSnapshotOptions = {
  controllerId: string;
  tabId: number;
  textOffset: number;
};

const readSnapshot = async ({
  controllerId,
  tabId,
  textOffset,
}: ReadSnapshotOptions): Promise<BrowserControlResult> => {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === undefined || parseControllableUrl(tab.url) === null) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
      UNSUPPORTED_PAGE_MESSAGE,
    );
  }
  const results = await runPageOperation(
    { allFrames: true, tabId },
    {
      kind: "snapshot",
      limits: BROWSER_CONTROL_LIMITS,
      shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
    },
  );
  const frames = results.flatMap(({ documentId, frameId, result }) => {
    const parsed = v.safeParse(frameSnapshotSchema, result);
    return parsed.success
      ? [{ documentId, frameId, snapshot: parsed.output }]
      : [];
  });
  // The tab URL was checked before injection; the page may have navigated
  // since, so the document that was actually read is checked again.
  const top = frames.find(({ frameId }) => frameId === TOP_FRAME_ID);
  if (
    top &&
    !isControllableFrame({
      isTopFrame: true,
      origin: top.snapshot.origin,
      url: top.snapshot.url,
    })
  ) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
      UNSUPPORTED_PAGE_MESSAGE,
    );
  }
  const merged = mergeFrameSnapshots({ frames, textOffset });
  if (!merged) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page returned an invalid snapshot.",
    );
  }
  const parsed = parseBrowserControlResult({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      revision: crypto.randomUUID(),
      tabId,
      ...merged,
    },
    status: "success",
  } satisfies BrowserControlResult);
  if (!parsed) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page returned a snapshot outside the protocol bounds.",
    );
  }
  if (parsed.status === "success") {
    await writeControlledTabState({
      adopted: (await readControlledTabState())?.adopted ?? false,
      controllerId,
      snapshot: {
        documents: Object.fromEntries(
          frames.map(({ documentId, frameId }) => [
            String(frameId),
            documentId,
          ]),
        ),
        revision: parsed.snapshot.revision,
        tabId,
        url: parsed.snapshot.url,
      },
      tabId,
    });
  }
  return parsed;
};

/**
 * Reads the page after a dispatched action or back navigation. The action
 * may already have taken effect, so every failure here is `outcome-unknown`,
 * and a snapshot that raced a navigation is retaken once the page settles.
 */
const readOutcome = async (
  navigation: TabNavigationObserver,
  controllerId: string,
  tabId: number,
  signal: AbortSignal,
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
      result = await readSnapshot({ controllerId, tabId, textOffset: 0 });
    } catch {
      result = null;
    }
    if (navigation.generation() !== generation) {
      continue;
    }
    if (result?.status === "success") {
      return result;
    }
    return outcomeUnknown(
      result === null
        ? "Chrome could not read the page after the action."
        : `The page after the action could not be read: ${result.message}`,
    );
  }
  return outcomeUnknown("The page kept navigating after the action.");
};

export type AdoptControlledTabResult =
  | { status: "adopted"; tabId: number; url: string }
  | { status: "unsupported-page" };

/**
 * Makes a tab the user already has open the controlled tab, so chat can read
 * and act on it without re-navigating. Same origin policy and containment as
 * a tab opened by `open`; the controller's own stella tab is never adopted.
 */
export const adoptControlledTab = async (
  controllerId: string,
  tab: chrome.tabs.Tab,
): Promise<AdoptControlledTabResult> => {
  const controller = await readBrowserController();
  if (
    controller?.controllerId !== controllerId ||
    tab.id === undefined ||
    tab.id === controller.tabId ||
    tab.url === undefined ||
    parseControllableUrl(tab.url) === null
  ) {
    return { status: "unsupported-page" };
  }
  await containControlledTab(tab.id);
  await writeControlledTabState({
    adopted: true,
    controllerId,
    snapshot: null,
    tabId: tab.id,
  });
  return { status: "adopted", tabId: tab.id, url: tab.url };
};

type OpenedControlledTab =
  | { status: "cancelled" }
  | { loaded: boolean; status: "navigated"; tabId: number }
  | { status: "unavailable" };

/**
 * Points the controlled tab at an approved URL. A new tab starts at
 * `about:blank` so the containment rules are in place before it requests
 * anything.
 */
const openControlledTab = async (
  controllerId: string,
  url: URL,
  signal: AbortSignal,
): Promise<OpenedControlledTab> => {
  const existing = await readControlledTab(controllerId);
  const tabId =
    existing?.tab.id ??
    (await chrome.tabs.create({ active: true, url: "about:blank" })).id;
  if (tabId === undefined) {
    return { status: "unavailable" };
  }
  await containControlledTab(tabId);
  await writeControlledTabState({
    adopted: existing?.state.adopted ?? false,
    controllerId,
    snapshot: null,
    tabId,
  });
  if (isStopped(signal)) {
    return { status: "cancelled" };
  }
  const navigation = createTabNavigationObserver(tabId);
  try {
    await chrome.tabs.update(tabId, { active: true, url: url.href });
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
  /** The tab and snapshot the web client last saw a result for. */
  observedTab: BrowserObservedTab | null;
  /** Aborts when chat stops the command or control changes. */
  signal: AbortSignal;
};

const identityRefusal = (
  status: "stale-snapshot" | "tab-changed",
): BrowserControlResult =>
  status === "tab-changed"
    ? browserControlError(
        BROWSER_CONTROL_ERROR_CODE.tabChanged,
        "The controlled tab changed since stella last read it. Take a snapshot of the current tab before navigating or acting.",
      )
    : browserControlError(
        BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
        "The page changed after this browser action was proposed. Take a new snapshot before acting.",
      );

export const executeBrowserCommand = async (
  controllerId: string,
  command: BrowserControlCommand,
  { observedTab, signal }: ExecuteBrowserCommandOptions,
): Promise<BrowserControlResult> => {
  // Set once a click, fill, select, key press or navigation has been handed
  // to the page or tab; from then on a failure cannot say it did not run.
  let dispatched = false;
  try {
    if (isStopped(signal)) {
      return cancelled();
    }
    const controlledTab = await readControlledTab(controllerId);
    const tabId = controlledTab?.tab.id;
    const identity = checkCommandIdentity({
      command,
      controlledTab:
        controlledTab === null || tabId === undefined
          ? null
          : {
              adopted: controlledTab.state.adopted,
              tabId,
              url: controlledTab.tab.url,
            },
      observedTab,
      snapshot: controlledTab?.state.snapshot ?? null,
    });
    if (identity.status !== "ok") {
      return identityRefusal(identity.status);
    }

    if (command.action === BROWSER_CONTROL_ACTION.open) {
      const requested = parseControllableUrl(command.url);
      if (requested === null) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.navigationFailed,
          "Only public HTTPS pages without embedded credentials can be opened; stella itself and intranet, loopback and private addresses are refused.",
        );
      }
      dispatched = true;
      const opened = await openControlledTab(controllerId, requested, signal);
      if (opened.status === "cancelled") {
        return cancelled();
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
      if (landedUrl === null || landedUrl.origin !== requested.origin) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.redirected,
          `The page redirected away from ${requested.origin} to ${landedUrl?.origin ?? "an unsupported address"} and was not read. Use snapshot to read it after approval.`,
        );
      }
      return await readSnapshot({
        controllerId,
        tabId: opened.tabId,
        textOffset: 0,
      });
    }

    if (!controlledTab) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.noControlledTab,
        "Open a page with stella before using this action.",
      );
    }
    if (tabId === undefined) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.tabClosed,
        "The controlled Chrome tab is no longer available.",
      );
    }
    const { state, tab } = controlledTab;

    if (command.action === BROWSER_CONTROL_ACTION.snapshot) {
      return await readSnapshot({
        controllerId,
        tabId,
        textOffset: command.textOffset ?? 0,
      });
    }

    if (command.action === BROWSER_CONTROL_ACTION.goBack) {
      const navigation = createTabNavigationObserver(tabId);
      try {
        await forgetSnapshot(state);
        if (isStopped(signal)) {
          return cancelled();
        }
        dispatched = true;
        await navigateBack(tabId);
        return await readOutcome(navigation, controllerId, tabId, signal);
      } finally {
        navigation.dispose();
      }
    }

    if (tab.url === undefined || parseControllableUrl(tab.url) === null) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
        UNSUPPORTED_PAGE_MESSAGE,
      );
    }
    const reference = parseElementReference(command.target.ref);
    if (!reference || identity.documentId === null) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.invalidCommand,
        "The element reference is malformed.",
      );
    }
    const frame = await checkActionFrame(
      tabId,
      reference.frameId,
      identity.documentId,
    );
    if (!frame.ok) {
      return frame.error;
    }
    const navigation = createTabNavigationObserver(tabId);
    try {
      await forgetSnapshot(state);
      if (isStopped(signal)) {
        return cancelled();
      }
      dispatched = true;
      const outcome = await injectDomAction(
        tabId,
        identity.documentId,
        reference.path,
        frame.origin,
        command,
      );
      if (outcome.status === "refused") {
        // The page refused before acting, so the snapshot still describes it.
        await writeControlledTabState(state);
        return browserControlError(outcome.code, outcome.error);
      }
      if (outcome.status === "unobserved") {
        return outcomeUnknown(
          "Chrome lost the page before the action reported back.",
        );
      }
      return await readOutcome(navigation, controllerId, tabId, signal);
    } finally {
      navigation.dispose();
    }
  } catch {
    if (dispatched) {
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

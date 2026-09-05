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
  parseBrowserControlResult,
  parseElementReference,
} from "@stll/api-contract/browser-control";

import { browserControlError } from "./browser-control-result";
import {
  containDownloads,
  releaseDownloadContainment,
} from "./download-containment";
import { parseControllableUrl } from "./origin-policy";
import { browserCommandMatchesSnapshot } from "./snapshot-guard";
import { frameSnapshotSchema, mergeFrameSnapshots } from "./snapshot-merge";
import { BROWSER_CONTROLLED_TAB_STORAGE_KEY } from "./storage-keys";

const NAVIGATION_TIMEOUT_MS = 15_000;
const PAGE_SETTLE_MS = 250;
const UNSUPPORTED_PAGE_MESSAGE =
  "Only public HTTPS pages can be read or operated. Open one first.";

const isBrowserControlErrorCode = (
  input: string,
): input is BrowserControlErrorCode =>
  Object.values(BROWSER_CONTROL_ERROR_CODE).some(
    (errorCode) => errorCode === input,
  );

type ControlledTabState = {
  controllerId: string;
  revision: string | null;
  tabId: number;
  url: string | null;
};

const parseControlledTabState = (input: unknown): ControlledTabState | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("controllerId" in input) ||
    typeof input.controllerId !== "string" ||
    !("revision" in input) ||
    (typeof input.revision !== "string" && input.revision !== null) ||
    !("tabId" in input) ||
    typeof input.tabId !== "number" ||
    !Number.isSafeInteger(input.tabId) ||
    !("url" in input) ||
    (typeof input.url !== "string" && input.url !== null)
  ) {
    return null;
  }
  return {
    controllerId: input.controllerId,
    revision: input.revision,
    tabId: input.tabId,
    url: input.url,
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

export const forgetControlledTab = async (tabId: number): Promise<void> => {
  const state = await readControlledTabState();
  if (state?.tabId === tabId) {
    await chrome.storage.session.remove(BROWSER_CONTROLLED_TAB_STORAGE_KEY);
    await releaseDownloadContainment();
  }
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
    return null;
  }
};

const waitForTabLoad = async (tabId: number): Promise<boolean> => {
  let listener = (
    _updatedTabId: number,
    _changeInfo: { status?: string },
  ): void => undefined;
  const loaded = new Promise<boolean>((resolve) => {
    listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    chrome.tabs.onUpdated.removeListener(listener);
    return true;
  }
  let resolveTimeout = (_loaded: boolean): void => undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeout = setTimeout(
    () => resolveTimeout(false),
    NAVIGATION_TIMEOUT_MS,
  );
  const result = await Promise.race([loaded, timedOut]);
  clearTimeout(timeout);
  chrome.tabs.onUpdated.removeListener(listener);
  return result;
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

const settlePage = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), PAGE_SETTLE_MS);
  });
};

const createTabNavigationObserver = (tabId: number) => {
  let completed = false;
  let navigationStarted = false;
  let resolveStarted = (): void => undefined;
  let resolveCompleted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const loaded = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const listener = (
    updatedTabId: number,
    changeInfo: { status?: string; url?: string },
  ): void => {
    if (updatedTabId !== tabId) {
      return;
    }
    if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
      navigationStarted = true;
      resolveStarted();
    }
    if (changeInfo.status === "complete") {
      completed = true;
      resolveCompleted();
    }
  };
  chrome.tabs.onUpdated.addListener(listener);

  return {
    dispose() {
      chrome.tabs.onUpdated.removeListener(listener);
    },
    async waitForSettled(): Promise<boolean> {
      await Promise.race([started, settlePage()]);
      const current = await chrome.tabs.get(tabId);
      if (!navigationStarted && current.status !== "loading") {
        return true;
      }
      if (completed || current.status === "complete") {
        return true;
      }
      let resolveTimeout = (): void => undefined;
      const timedOut = new Promise<void>((resolve) => {
        resolveTimeout = resolve;
      });
      const timeout = setTimeout(resolveTimeout, NAVIGATION_TIMEOUT_MS);
      const outcome = await Promise.race([
        loaded.then(() => true),
        timedOut.then(() => false),
      ]);
      clearTimeout(timeout);
      return outcome;
    },
  };
};

type PageOperation =
  | {
      action: BrowserControlElementCommand;
      errorCode: typeof BROWSER_CONTROL_ERROR_CODE;
      kind: "action";
      limits: typeof BROWSER_CONTROL_LIMITS;
      path: string;
      shadowSegment: typeof ELEMENT_REFERENCE_SHADOW_SEGMENT;
    }
  | {
      kind: "snapshot";
      limits: typeof BROWSER_CONTROL_LIMITS;
      shadowSegment: typeof ELEMENT_REFERENCE_SHADOW_SEGMENT;
    };

/**
 * The one script injected into a frame of the controlled tab. Chrome
 * serializes `func`, so every DOM helper lives inside it; both operations
 * share this single copy. Element paths are frame-local; the worker qualifies
 * them with the frame id.
 */
const runPageOperation = async (
  injectionTarget: chrome.scripting.InjectionTarget,
  operation: PageOperation,
) =>
  await chrome.scripting.executeScript({
    args: [operation],
    func: (pageOperation) => {
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
            !visible(node)
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
        if (element instanceof HTMLInputElement) {
          return element.type === "password"
            ? undefined
            : element.value.slice(0, limits.valueChars);
        }
        if (
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
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
      const performDefaultKeyAction = (
        element: HTMLElement,
        key: (typeof BROWSER_CONTROL_KEYS)[number],
      ) => {
        switch (key) {
          case "Enter":
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
            return;
          case "Space":
            if (
              element instanceof HTMLButtonElement ||
              (element instanceof HTMLInputElement &&
                (element.type === "checkbox" || element.type === "radio"))
            ) {
              element.click();
            }
            return;
          case "Backspace":
            editValue(element, (value) => value.slice(0, -1));
            return;
          case "Tab":
            moveFocus(element);
            return;
          case "ArrowDown":
          case "ArrowRight":
            stepSelect(element, 1);
            return;
          case "ArrowUp":
          case "ArrowLeft":
            stepSelect(element, -1);
            return;
          case "Escape":
            element.blur();
            return;
          default:
            key satisfies never;
            throw new TypeError("Unhandled browser key");
        }
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
              !isDisabled(element)
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
          text: collectText(document.body, limits.pageTextTotalChars),
          title: document.title.slice(0, limits.titleChars),
          url: window.location.href.slice(0, limits.urlChars),
        };
      }

      const { action, errorCode } = pageOperation;
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
      if (isDisabled(target)) {
        return {
          code: errorCode.executionFailed,
          error:
            "The control is disabled; the page does not accept this action.",
          ok: false,
        };
      }
      const isPasswordField =
        target instanceof HTMLInputElement && target.type === "password";

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
          if (isPasswordField) {
            return {
              error: "Password fields must be completed manually.",
              code: errorCode.sensitiveField,
              ok: false,
            };
          }
          Reflect.set(
            HTMLInputElement.prototype,
            "value",
            action.value,
            target,
          );
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
      if (isPasswordField) {
        return {
          error: "Password fields must be completed manually.",
          code: errorCode.sensitiveField,
          ok: false,
        };
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

const injectDomAction = async (
  tabId: number,
  command: BrowserControlElementCommand,
): Promise<
  { code: BrowserControlErrorCode; error: string; ok: false } | { ok: true }
> => {
  const reference = parseElementReference(command.target.ref);
  if (!reference) {
    return {
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      error: "The element reference is malformed.",
      ok: false,
    };
  }
  const results = await runPageOperation(
    { frameIds: [reference.frameId], tabId },
    {
      action: command,
      errorCode: BROWSER_CONTROL_ERROR_CODE,
      kind: "action",
      limits: BROWSER_CONTROL_LIMITS,
      path: reference.path,
      shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
    },
  );
  const result: unknown = results.at(0)?.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    typeof result.ok !== "boolean"
  ) {
    return {
      code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
      error: "The page did not return an action result.",
      ok: false,
    };
  }
  if (result.ok) {
    return { ok: true };
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
    ok: false,
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
  const frames = results.flatMap(({ frameId, result }) => {
    const parsed = v.safeParse(frameSnapshotSchema, result);
    return parsed.success ? [{ frameId, snapshot: parsed.output }] : [];
  });
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
      controllerId,
      revision: parsed.snapshot.revision,
      tabId,
      url: parsed.snapshot.url,
    });
  }
  return parsed;
};

export type AdoptControlledTabResult =
  | { status: "adopted"; url: string }
  | { status: "unsupported-page" };

/**
 * Makes a tab the user already has open the controlled tab, so chat can read
 * and act on it without re-navigating. Same origin policy and download
 * containment as a tab opened by `open`.
 */
export const adoptControlledTab = async (
  controllerId: string,
  tab: chrome.tabs.Tab,
): Promise<AdoptControlledTabResult> => {
  if (
    tab.id === undefined ||
    tab.url === undefined ||
    parseControllableUrl(tab.url) === null
  ) {
    return { status: "unsupported-page" };
  }
  await containDownloads(tab.id);
  await writeControlledTabState({
    controllerId,
    revision: null,
    tabId: tab.id,
    url: null,
  });
  return { status: "adopted", url: tab.url };
};

const openControlledTab = async (
  controllerId: string,
  url: URL,
): Promise<chrome.tabs.Tab | null> => {
  const existing = await readControlledTab(controllerId);
  const tab =
    existing?.tab.id !== undefined
      ? await chrome.tabs.update(existing.tab.id, {
          active: true,
          url: url.href,
        })
      : await chrome.tabs.create({ active: true, url: url.href });
  if (!tab || tab.id === undefined) {
    return null;
  }
  await containDownloads(tab.id);
  await writeControlledTabState({
    controllerId,
    revision: null,
    tabId: tab.id,
    url: null,
  });
  return tab;
};

export const executeBrowserCommand = async (
  controllerId: string,
  command: BrowserControlCommand,
): Promise<BrowserControlResult> => {
  try {
    const controlledTab = await readControlledTab(controllerId);
    if (command.action === BROWSER_CONTROL_ACTION.open) {
      const requested = parseControllableUrl(command.url);
      const tab =
        requested === null
          ? null
          : await openControlledTab(controllerId, requested);
      if (requested === null || tab?.id === undefined) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.navigationFailed,
          "Only public HTTPS pages without embedded credentials can be opened; intranet, loopback and private addresses are refused.",
        );
      }
      if (!(await waitForTabLoad(tab.id))) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.timedOut,
          "The page did not finish loading in time.",
        );
      }
      // The user approved the requested origin, not wherever it redirected.
      // Reading the landing page needs its own approved snapshot.
      const landed = await chrome.tabs.get(tab.id);
      const landedUrl =
        landed.url === undefined ? null : parseControllableUrl(landed.url);
      if (landedUrl === null || landedUrl.origin !== requested.origin) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.redirected,
          `The page redirected away from ${requested.origin} to ${landedUrl?.origin ?? "an unsupported address"} and was not read. Use snapshot to read it after approval.`,
        );
      }
      return await readSnapshot({ controllerId, tabId: tab.id, textOffset: 0 });
    }

    if (!controlledTab) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.noControlledTab,
        "Open a page with stella before using this action.",
      );
    }
    const tabId = controlledTab.tab.id;
    if (tabId === undefined) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.tabClosed,
        "The controlled Chrome tab is no longer available.",
      );
    }
    const { state, tab } = controlledTab;

    if (command.action === BROWSER_CONTROL_ACTION.goBack) {
      const navigation = createTabNavigationObserver(tabId);
      let loaded = false;
      try {
        await navigateBack(tabId);
        loaded = await navigation.waitForSettled();
      } finally {
        navigation.dispose();
      }
      if (!loaded) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.timedOut,
          "The previous page did not finish loading in time.",
        );
      }
      return await readSnapshot({ controllerId, tabId, textOffset: 0 });
    }

    if (command.action === BROWSER_CONTROL_ACTION.snapshot) {
      return await readSnapshot({
        controllerId,
        tabId,
        textOffset: command.textOffset ?? 0,
      });
    }

    if (tab.url === undefined || parseControllableUrl(tab.url) === null) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
        UNSUPPORTED_PAGE_MESSAGE,
      );
    }
    if (!browserCommandMatchesSnapshot(state, tab.url, command)) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
        "The page changed after this browser action was proposed. Take a new snapshot before acting.",
      );
    }
    const navigation = createTabNavigationObserver(tabId);
    let actionResult: Awaited<ReturnType<typeof injectDomAction>>;
    let loaded = false;
    try {
      actionResult = await injectDomAction(tabId, command);
      if (actionResult.ok) {
        loaded = await navigation.waitForSettled();
      }
    } finally {
      navigation.dispose();
    }
    if (!actionResult.ok) {
      return browserControlError(actionResult.code, actionResult.error);
    }
    if (!loaded) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.timedOut,
        "The page did not finish loading after the action.",
      );
    }
    return await readSnapshot({ controllerId, tabId, textOffset: 0 });
  } catch {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "Chrome could not run this action on the current page. Error pages and blocked file downloads cannot be read; open another page or go back.",
    );
  }
};

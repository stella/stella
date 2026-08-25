import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  parseBrowserControlResult,
} from "@stll/api-contract/browser-control";

import { browserControlError } from "./browser-control-result";
import { browserCommandMatchesSnapshot } from "./snapshot-guard";
import { BROWSER_CONTROLLED_TAB_STORAGE_KEY } from "./storage-keys";

const NAVIGATION_TIMEOUT_MS = 15_000;
const PAGE_SETTLE_MS = 250;

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

const parseHttpUrl = (rawUrl: string): URL | null => {
  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url;
  } catch {
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
      action: BrowserControlCommand;
      errorCode: typeof BROWSER_CONTROL_ERROR_CODE;
      kind: "action";
      limits: typeof BROWSER_CONTROL_LIMITS;
    }
  | {
      contentTrust: typeof BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent;
      kind: "snapshot";
      limits: typeof BROWSER_CONTROL_LIMITS;
      protocolVersion: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
      snapshotRevision: string;
    };

/**
 * The one script injected into the controlled tab. Chrome serializes `func`,
 * so every DOM helper lives inside it; both operations share this single copy.
 */
const runPageOperation = async (
  tabId: number,
  operation: PageOperation,
): Promise<unknown> => {
  const results = await chrome.scripting.executeScript({
    args: [operation],
    func: (operation) => {
      const { limits } = operation;
      const normalize = (value: string) =>
        value.replaceAll(/\s+/gu, " ").trim();
      const visible = (element: Element) => {
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          element.getClientRects().length > 0
        );
      };
      const visibleText = (root: Element, maxChars: number) => {
        const parts: string[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let totalChars = 0;
        let node = walker.nextNode();
        while (node && totalChars < maxChars) {
          const parent = node.parentElement;
          if (parent && visible(parent) && node.nodeValue) {
            const value = node.nodeValue.slice(0, maxChars - totalChars);
            parts.push(value);
            totalChars += value.length;
          }
          node = walker.nextNode();
        }
        return parts.join(" ");
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
            visibleText(element, limits.elementNameChars),
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
      const referenceFor = (element: Element) => {
        const indexes: number[] = [];
        let current = element;
        while (current !== document.documentElement) {
          const parent = current.parentElement;
          if (!parent) {
            return null;
          }
          const index = Array.prototype.indexOf.call(parent.children, current);
          if (index < 0) {
            return null;
          }
          indexes.push(index);
          current = parent;
        }
        return `e:${indexes.toReversed().join(".")}`;
      };
      const resolveReference = (reference: string): Element | null => {
        const indexes = reference.slice(2).split(".").map(Number);
        let current: Element = document.documentElement;
        for (const index of indexes) {
          const next = current.children.item(index);
          if (!next) {
            return null;
          }
          current = next;
        }
        return current;
      };

      if (operation.kind === "snapshot") {
        const selectors = [
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
          name: string;
          ref: string;
          role: string;
          value?: string;
        }[] = [];
        for (const element of document.querySelectorAll(selectors)) {
          if (elements.length >= limits.elements || !visible(element)) {
            continue;
          }
          const ref = referenceFor(element);
          if (!ref) {
            continue;
          }
          const value = valueFor(element);
          elements.push({
            name: nameFor(element),
            ref,
            role: roleFor(element),
            ...(value === undefined ? {} : { value }),
          });
        }

        return {
          protocolVersion: operation.protocolVersion,
          snapshot: {
            contentTrust: operation.contentTrust,
            elements,
            revision: operation.snapshotRevision,
            text: normalize(
              visibleText(document.body, limits.pageTextChars),
            ).slice(0, limits.pageTextChars),
            title: document.title.slice(0, limits.titleChars),
            url: window.location.href.slice(0, limits.urlChars),
          },
          status: "success",
        };
      }

      const { action, errorCode } = operation;
      if (
        action.action === "open" ||
        action.action === "snapshot" ||
        action.action === "go-back"
      ) {
        return {
          code: errorCode.invalidCommand,
          error: "Unsupported injected action.",
          ok: false,
        };
      }

      const target = resolveReference(action.target.ref);
      if (!target) {
        return {
          error: "The referenced element is no longer on the page.",
          code: errorCode.elementNotFound,
          ok: false,
        };
      }
      if (
        nameFor(target) !== action.target.name ||
        roleFor(target) !== action.target.role
      ) {
        return {
          error: "The referenced element changed after the page snapshot.",
          code: errorCode.staleSnapshot,
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
      target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
      return { ok: true };
    },
    target: { tabId },
  });
  return results.at(0)?.result;
};

const injectDomAction = async (
  tabId: number,
  command: BrowserControlCommand,
): Promise<
  { code: BrowserControlErrorCode; error: string; ok: false } | { ok: true }
> => {
  const result = await runPageOperation(tabId, {
    action: command,
    errorCode: BROWSER_CONTROL_ERROR_CODE,
    kind: "action",
    limits: BROWSER_CONTROL_LIMITS,
  });
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

const readSnapshot = async (
  controllerId: string,
  tabId: number,
): Promise<BrowserControlResult> => {
  const result = await runPageOperation(tabId, {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    kind: "snapshot",
    limits: BROWSER_CONTROL_LIMITS,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshotRevision: crypto.randomUUID(),
  });
  const parsed = parseBrowserControlResult(result);
  if (!parsed) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "The page returned an invalid snapshot.",
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

const openControlledTab = async (
  controllerId: string,
  rawUrl: string,
): Promise<chrome.tabs.Tab | null> => {
  const url = parseHttpUrl(rawUrl);
  if (!url) {
    return null;
  }

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
      const tab = await openControlledTab(controllerId, command.url);
      if (tab?.id === undefined) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.navigationFailed,
          "Only HTTP and HTTPS pages without embedded credentials can be opened.",
        );
      }
      if (!(await waitForTabLoad(tab.id))) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.timedOut,
          "The page did not finish loading in time.",
        );
      }
      return await readSnapshot(controllerId, tab.id);
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
        await chrome.tabs.goBack(tabId);
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
      return await readSnapshot(controllerId, tabId);
    }

    if (command.action !== BROWSER_CONTROL_ACTION.snapshot) {
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
    }

    return await readSnapshot(controllerId, tabId);
  } catch {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.executionFailed,
      "Chrome could not execute the browser action on this page.",
    );
  }
};

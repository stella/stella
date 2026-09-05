import { useSyncExternalStore } from "react";

import * as v from "valibot";

import {
  type BrowserControlCommand,
  isReadOnlyBrowserCommand,
} from "@stll/api-contract/browser-control";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

/**
 * How much of the browser tool the user lets run without a click. Scoped to
 * the web tab session: one stella tab pairs with one controlled Chrome tab,
 * so the grant lives and dies with that pairing rather than with a thread.
 */
export const BROWSER_APPROVAL_MODE = {
  askEveryTime: "ask-every-time",
  autoApproveAll: "auto-approve-all",
  autoApproveReads: "auto-approve-reads",
} as const;

export type BrowserApprovalMode =
  (typeof BROWSER_APPROVAL_MODE)[keyof typeof BROWSER_APPROVAL_MODE];

const STORAGE_KEY = "stella.chat.browserApprovalMode";
const modeSchema = v.picklist(Object.values(BROWSER_APPROVAL_MODE));

type BrowserApprovalModeStore = {
  listeners: Set<() => void>;
  mode: BrowserApprovalMode;
};

let store: BrowserApprovalModeStore | null = null;

const getStore = (): BrowserApprovalModeStore => {
  store ??= {
    listeners: new Set(),
    mode:
      readStoredJson(window.sessionStorage.getItem(STORAGE_KEY), modeSchema) ??
      BROWSER_APPROVAL_MODE.askEveryTime,
  };
  return store;
};

const getSnapshot = (): BrowserApprovalMode => getStore().mode;

const getServerSnapshot = (): BrowserApprovalMode =>
  BROWSER_APPROVAL_MODE.askEveryTime;

const subscribe = (listener: () => void) => {
  const { listeners } = getStore();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setBrowserApprovalMode = (mode: BrowserApprovalMode): void => {
  const current = getStore();
  current.mode = mode;
  writeStoredJson(window.sessionStorage, STORAGE_KEY, mode);
  for (const listener of current.listeners) {
    listener();
  }
};

export const useBrowserApprovalMode = (): BrowserApprovalMode =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export const browserApprovalModeAllows = (
  mode: BrowserApprovalMode,
  command: BrowserControlCommand,
): boolean => {
  switch (mode) {
    case BROWSER_APPROVAL_MODE.askEveryTime:
      return false;
    case BROWSER_APPROVAL_MODE.autoApproveReads:
      return isReadOnlyBrowserCommand(command);
    case BROWSER_APPROVAL_MODE.autoApproveAll:
      return true;
    default:
      mode satisfies never;
      return false;
  }
};

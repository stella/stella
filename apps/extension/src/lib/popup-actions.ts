import { panic } from "better-result";

import type { PopupAction } from "./popup-view";

/** The tab fields the popup reads: its id to address it and its url to classify it. */
export type PopupTab = Pick<chrome.tabs.Tab, "id" | "url">;

type PopupActionDependencies = {
  requestAccess: () => Promise<boolean>;
  readActiveTab: () => Promise<PopupTab | null>;
  /** Connects the stella tab with this id, or else opens or finds one. */
  connectWebsite: (tabId: number | null) => Promise<void>;
  adopt: (tab: PopupTab | null) => Promise<void>;
  disconnect: () => Promise<void>;
  revoke: () => Promise<void>;
  render: () => Promise<void>;
};

/**
 * Runs one popup click. Connecting asks for website access first,
 * synchronously within the click's user gesture, as Chrome requires.
 */
export const runPopupAction = async (
  action: PopupAction,
  deps: PopupActionDependencies,
): Promise<void> => {
  switch (action.action) {
    case "connect-website": {
      if (action.askAccess && !(await deps.requestAccess())) {
        await deps.render();
        return;
      }
      await deps.connectWebsite(action.tabId);
      return;
    }
    case "adopt":
      await deps.adopt(await deps.readActiveTab());
      return;
    case "disconnect":
      await deps.disconnect();
      await deps.render();
      return;
    case "revoke":
      await deps.revoke();
      await deps.render();
      return;
    default:
      action satisfies never;
      panic("Unhandled popup action");
  }
};

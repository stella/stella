import { panic } from "better-result";

import type { PopupAction, PopupSecondaryAction } from "./popup-view";

type PopupActionDependencies = {
  renderedTab: chrome.tabs.Tab | null;
  requestAccess: () => Promise<boolean>;
  readActiveTab: () => Promise<chrome.tabs.Tab | null>;
  pair: (tab: chrome.tabs.Tab | null) => Promise<void>;
  adopt: (tab: chrome.tabs.Tab | null) => Promise<void>;
  disconnect: () => Promise<void>;
  revoke: () => Promise<void>;
  render: () => Promise<void>;
};

/** Grant actions must call requestAccess first, synchronously within the click's user gesture. */
export const runPopupAction = async (
  action: PopupAction["action"] | PopupSecondaryAction["action"],
  deps: PopupActionDependencies,
): Promise<void> => {
  switch (action) {
    case "grant":
    case "grant-and-connect": {
      const granted = await deps.requestAccess();
      if (!granted) {
        await deps.render();
        return;
      }
      if (action === "grant-and-connect") {
        await deps.pair(deps.renderedTab);
      } else {
        await deps.render();
      }
      return;
    }
    case "connect":
      await deps.pair(await deps.readActiveTab());
      return;
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

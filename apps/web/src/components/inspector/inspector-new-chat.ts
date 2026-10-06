import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import type { InspectorTabsActions } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";

/** Reuse the mounted chat's seeded rotation; a cold pane has no composer to preserve. */
export const startNewInspectorChat = (
  fallbackArgs: Parameters<InspectorTabsActions["openChat"]>[0] = {},
) => {
  const tabs = useInspectorTabsStore.getState();
  const command = useInspectorCommandStore.getState().newChatCommand;
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeId);
  if (
    !tabs.minimized &&
    active?.type === "chat" &&
    command?.tabId === active.id
  ) {
    command.run();
    return;
  }
  tabs.openChat(fallbackArgs);
};

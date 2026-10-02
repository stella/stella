import { panic } from "better-result";

import type { TranslationKey } from "@/i18n/types";

/**
 * Where a chat opened in the side panel stands, as the control that asked
 * for it shows it: nothing to say, the chat is being made (a fork waits on
 * the server), or the chat is there and the control says so for a moment.
 */
export const SIDE_PANEL_CHAT_STATUS = {
  creating: "creating",
  idle: "idle",
  ready: "ready",
} as const;
export type SidePanelChatStatus =
  (typeof SIDE_PANEL_CHAT_STATUS)[keyof typeof SIDE_PANEL_CHAT_STATUS];

export type SidePanelChatEvent =
  /** The chat is being made. */
  | "start"
  /** The chat opened in the side panel. */
  | "opened"
  /** Making it failed; the caller reports the error. */
  | "failed"
  /** The confirmation has been on screen long enough. */
  | "settled";

/**
 * How long "available in the side panel" stays. Longer than a copy's
 * check mark: it is a sentence to read, not a glyph to glance at.
 */
export const SIDE_PANEL_CHAT_READY_MS = 2500;

export const nextSidePanelChatStatus = (
  status: SidePanelChatStatus,
  event: SidePanelChatEvent,
): SidePanelChatStatus => {
  switch (event) {
    case "start": {
      return SIDE_PANEL_CHAT_STATUS.creating;
    }
    case "opened": {
      return SIDE_PANEL_CHAT_STATUS.ready;
    }
    // A late failure or timer must not cut short a newer request.
    case "failed": {
      return status === SIDE_PANEL_CHAT_STATUS.creating
        ? SIDE_PANEL_CHAT_STATUS.idle
        : status;
    }
    case "settled": {
      return status === SIDE_PANEL_CHAT_STATUS.ready
        ? SIDE_PANEL_CHAT_STATUS.idle
        : status;
    }
    default: {
      event satisfies never;
      return panic(`Unhandled side-panel chat event: ${String(event)}`);
    }
  }
};

export const SIDE_PANEL_CHAT_STATUS_LABELS = {
  creating: "chat.forkingThread",
  ready: "chat.newChatInSidePanel",
} as const satisfies Record<
  Exclude<SidePanelChatStatus, "idle">,
  TranslationKey
>;

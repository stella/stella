export const FILE_CHAT_OVERLAY_ACTIVATION = {
  active: "active",
  deferred: "deferred",
} as const;

export type FileChatOverlayActivation =
  (typeof FILE_CHAT_OVERLAY_ACTIVATION)[keyof typeof FILE_CHAT_OVERLAY_ACTIVATION];

/**
 * Where the overlay's conversation is read while its composer floats over the
 * document: in the overlay's own floating card, or in a docked tab that is
 * already showing the same thread.
 */
export const OVERLAY_THREAD_PRESENTATION = {
  card: "card",
  tab: "tab",
} as const;

export type OverlayThreadPresentation =
  (typeof OVERLAY_THREAD_PRESENTATION)[keyof typeof OVERLAY_THREAD_PRESENTATION];

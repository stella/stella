export const FILE_CHAT_OVERLAY_ACTIVATION = {
  active: "active",
  deferred: "deferred",
} as const;

export type FileChatOverlayActivation =
  (typeof FILE_CHAT_OVERLAY_ACTIVATION)[keyof typeof FILE_CHAT_OVERLAY_ACTIVATION];

/**
 * How much of the chat the viewer floats over the document:
 *
 * - `active`: the live overlay, with its runtime and its history.
 * - `gated`: the same bar, in the same place, for a reader without an account.
 *   It sends nothing; pressing it asks for the account.
 * - `deferred`: no bar at all, for a surface that is not offering the chat,
 *   or whose conversation a docked tab on screen already offers.
 */
export const FILE_CHAT_OVERLAY_ACTIVATION = {
  active: "active",
  deferred: "deferred",
  gated: "gated",
} as const;

export type FileChatOverlayActivation =
  (typeof FILE_CHAT_OVERLAY_ACTIVATION)[keyof typeof FILE_CHAT_OVERLAY_ACTIVATION];

/**
 * Whether stella desktop can do work for the signed-in account, as the server
 * last heard from this account's desktop apps.
 *
 * - `current`: reported recently with a supported protocol.
 * - `outdated`: reported recently with an older protocol.
 * - `not_connected`: reported before, not recently (installed, not running).
 * - `none`: never reported for this account. An app that is installed but not
 *   linked to this account cannot report, so it reads as `none` too.
 */
export type DesktopPresence =
  | { type: "current" }
  | { type: "outdated" }
  | { type: "not_connected" }
  | { type: "none" };

export type DesktopPresenceType = DesktopPresence["type"];

const ASSUMED_PRESENCE = {
  type: "current",
} as const satisfies DesktopPresence;

/**
 * The desktop app's presence for this account. Until the presence endpoint
 * ships, a current app is assumed: desktop actions deep-link into it, which
 * is how they behaved before presence existed.
 */
export const useDesktopPresence = (): DesktopPresence => ASSUMED_PRESENCE;

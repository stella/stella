import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

/**
 * What the desktop settings card shows, from the strongest signal down:
 * a pending approval the app just asked for, then the server's record of a
 * linked app, and otherwise an offer to install or connect it. The page does
 * not probe the local bridge for presence: it answers only a connection the
 * app itself started.
 */
export type DesktopCardState =
  | { type: "connected"; version: string }
  | { type: "outdated"; version: string }
  | { type: "approve" }
  | { type: "missing" };

export const desktopCardState = ({
  challengeWaiting,
  presence,
}: {
  challengeWaiting: boolean;
  presence: DesktopPresence | undefined;
}): DesktopCardState => {
  if (challengeWaiting) {
    return { type: "approve" };
  }
  if (presence?.type === "current") {
    return { type: "connected", version: presence.desktop.version };
  }
  if (presence?.type === "outdated") {
    return { type: "outdated", version: presence.desktop.version };
  }
  return { type: "missing" };
};

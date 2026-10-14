import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

/**
 * What the desktop settings card shows, from the strongest signal down:
 * the server's record of a linked app, a pending approval the app just asked
 * for, an app answering on this computer, and finally nothing found.
 */
export type DesktopCardState =
  | { type: "connected"; version: string }
  | { type: "outdated"; version: string }
  | { type: "approve" }
  | { type: "running" }
  | { type: "missing" };

export const desktopCardState = ({
  appRunning,
  challengeWaiting,
  presence,
}: {
  appRunning: boolean;
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
  return appRunning ? { type: "running" } : { type: "missing" };
};

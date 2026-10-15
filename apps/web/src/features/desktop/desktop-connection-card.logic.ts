import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

/**
 * What the desktop settings card shows, from the strongest signal down:
 * a pending approval the app just asked for, then the server's record of a
 * linked app, and otherwise an offer to install or connect it. The page does
 * not probe the local bridge for presence: it answers only a connection the
 * app itself started.
 */
export type DesktopCardState =
  | { type: "connected"; version: string; onThisComputer: boolean }
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
  // The record is per account, not per computer: an app linked elsewhere
  // does not mean this computer has one.
  if (presence?.type === "current") {
    return {
      type: "connected",
      version: presence.desktop.version,
      onThisComputer: false,
    };
  }
  if (presence?.type === "outdated") {
    return { type: "outdated", version: presence.desktop.version };
  }
  return { type: "missing" };
};

/**
 * Install and connect stay on offer until this computer itself holds the
 * link: a link on another computer, an outdated app or none at all still
 * leaves this one to set up. The card shows the downloads and the connect
 * button from this one decision, so they cannot disagree.
 */
export const offersDesktopSetup = (card: DesktopCardState): boolean =>
  card.type === "missing" ||
  card.type === "outdated" ||
  (card.type === "connected" && !card.onThisComputer);

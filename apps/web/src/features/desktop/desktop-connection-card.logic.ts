import { panic } from "better-result";

import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import type { DesktopConnectionState } from "@/features/desktop/desktop-connection-store.logic";

/**
 * What the desktop settings card shows, from the strongest signal down:
 * this computer's link in progress or just made, a pending approval the app
 * just asked for, then the server's record of a linked app, and otherwise an
 * offer to install or connect it. The page does not probe the local bridge
 * for presence: it answers only a connection the app itself started.
 */
export type DesktopCardState =
  | { type: "connected"; version: string; onThisComputer: boolean }
  | { type: "outdated"; version: string }
  | { type: "approve" }
  | { type: "verifying" }
  | { type: "opening"; desktopUrl: string }
  | { type: "missing" };

export const desktopCardState = ({
  challengeWaiting,
  connection,
  presence,
}: {
  challengeWaiting: boolean;
  connection: DesktopConnectionState;
  presence: DesktopPresence | undefined;
}): DesktopCardState => {
  const linking = linkingCardState({ challengeWaiting, connection });
  if (linking) {
    return linking;
  }
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

/** The card state a link on this computer decides, when one does. */
function linkingCardState({
  challengeWaiting,
  connection,
}: {
  challengeWaiting: boolean;
  connection: DesktopConnectionState;
}): DesktopCardState | null {
  switch (connection.status) {
    case "connected":
      return { type: "connected", version: "", onThisComputer: true };
    case "opening":
      return { type: "opening", desktopUrl: connection.desktopUrl };
    case "connecting":
      // The app's own proof is being checked: the page approves without a
      // click only if it holds, and otherwise shows "approve" again.
      return challengeWaiting && connection.approval === "local-proof"
        ? { type: "verifying" }
        : null;
    case "idle":
    case "update-required":
    case "error":
      return null;
    default:
      connection satisfies never;
      return panic("Unhandled desktop connection state");
  }
}

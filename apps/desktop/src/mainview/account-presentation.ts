import { panic } from "better-result";

import type { DesktopAccountSnapshot } from "../shared/rpc";

export type DesktopAccountState =
  DesktopAccountSnapshot | { status: "loading" } | { status: "unavailable" };

/** The host a person recognises ("my.stll.app"), not the full origin. */
export const serverHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * One presentation per account state, so the settings card always shows
 * which server it talks to, what is wrong, and the single action that fixes
 * it.
 */
export const accountPresentation = (state: DesktopAccountState) => {
  switch (state.status) {
    case "connected":
      return {
        actionKey: "disconnectAccount",
        actionVariant: "outline",
        descriptionKey: null,
        host: serverHost(state.server),
        status: "linked",
        statusKey: "accountLinked",
      } as const;
    case "expired":
      return {
        actionKey: "reconnect",
        actionVariant: "default",
        descriptionKey: "reconnectHostDescription",
        host: serverHost(state.server),
        status: "attention",
        statusKey: "connectionExpired",
      } as const;
    case "reconnectRequired":
      return {
        actionKey: "reconnect",
        actionVariant: "default",
        descriptionKey: "reconnectHostDescription",
        host: serverHost(state.server),
        status: "attention",
        statusKey: "reconnectNeeded",
      } as const;
    case "disconnected":
      return {
        actionKey: "connectToHost",
        actionVariant: "default",
        descriptionKey: "connectToHostDescription",
        host: serverHost(state.server),
        status: "not-linked",
        statusKey: "notConnected",
      } as const;
    case "loading":
      return {
        actionKey: "connectToStella",
        actionVariant: "outline",
        descriptionKey: null,
        host: null,
        status: "loading",
        statusKey: "notAvailableYet",
      } as const;
    case "unavailable":
      return {
        actionKey: "tryAgain",
        actionVariant: "outline",
        descriptionKey: "errorReadAccount",
        host: null,
        status: "unavailable",
        statusKey: "notAvailableYet",
      } as const;
    default:
      state satisfies never;
      return panic("Unknown desktop account state");
  }
};

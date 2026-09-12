import { panic } from "better-result";

import type { DesktopAccountSnapshot } from "../shared/rpc";

export type DesktopAccountState =
  | DesktopAccountSnapshot
  | { status: "loading" }
  | { status: "unavailable" };

export const accountPresentation = (state: DesktopAccountState) => {
  switch (state.status) {
    case "connected":
      return {
        actionKey: "disconnectAccount",
        status: "linked",
        statusKey: "accountLinked",
        webDescriptionKey: "stellaWebAccountDescription",
        webTitleKey: "stellaWebAccount",
      } as const;
    case "disconnected":
      return {
        actionKey: "connectToStella",
        status: "not-linked",
        statusKey: "notConnected",
        webDescriptionKey: "connectToStellaDescription",
        webTitleKey: "connectToStella",
      } as const;
    case "loading":
      return {
        actionKey: "connectToStella",
        status: "loading",
        statusKey: "notAvailableYet",
        webDescriptionKey: "notAvailableYet",
        webTitleKey: "stellaWebAccount",
      } as const;
    case "unavailable":
      return {
        actionKey: "tryAgain",
        status: "unavailable",
        statusKey: "notAvailableYet",
        webDescriptionKey: "errorReadAccount",
        webTitleKey: "stellaWebAccount",
      } as const;
    default:
      state satisfies never;
      return panic("Unknown desktop account state");
  }
};

import { describe, expect, test } from "bun:test";

import { accountPresentation } from "../src/mainview/account-presentation";
import type { LinkedAccountSnapshot } from "../src/shared/rpc";

const LINKED_ACCOUNT = {
  email: "user@example.com",
  name: "Example User",
  verifiedAt: "2026-09-12T20:00:00Z",
} satisfies LinkedAccountSnapshot;

describe("desktop account presentation", () => {
  test("a saved account presents web access instead of another connection prompt", () => {
    expect(
      accountPresentation({
        status: "connected",
        account: LINKED_ACCOUNT,
        expiresAt: "2026-09-19T20:00:00Z",
      }),
    ).toEqual({
      actionKey: "disconnectAccount",
      status: "linked",
      statusKey: "accountLinked",
      webDescriptionKey: "stellaWebAccountDescription",
      webTitleKey: "stellaWebAccount",
    });
  });

  test("a missing account presents the initial connection action", () => {
    expect(accountPresentation({ status: "disconnected" })).toEqual({
      actionKey: "connectToStella",
      status: "not-linked",
      statusKey: "notConnected",
      webDescriptionKey: "connectToStellaDescription",
      webTitleKey: "connectToStella",
    });
  });

  test("an account read failure never presents the account as disconnected", () => {
    expect(accountPresentation({ status: "unavailable" })).toEqual({
      actionKey: "tryAgain",
      status: "unavailable",
      statusKey: "notAvailableYet",
      webDescriptionKey: "errorReadAccount",
      webTitleKey: "stellaWebAccount",
    });
  });
});

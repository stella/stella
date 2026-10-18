import { describe, expect, test } from "bun:test";

import {
  accountPresentation,
  serverHost,
} from "../src/mainview/account-presentation";
import type { LinkedAccountSnapshot } from "../src/shared/rpc";

const LINKED_ACCOUNT = {
  email: "user@example.com",
  name: "Example User",
  verifiedAt: "2026-09-12T20:00:00Z",
} satisfies LinkedAccountSnapshot;
const SERVER = "https://my.stll.app";

describe("desktop account presentation", () => {
  test("a saved account names its server and offers disconnecting", () => {
    expect(
      accountPresentation({
        status: "connected",
        identity: { userId: "user_fixture", organizationId: "org_fixture" },
        account: LINKED_ACCOUNT,
        expiresAt: "2026-09-19T20:00:00Z",
        server: SERVER,
      }),
    ).toEqual({
      actionKey: "disconnectAccount",
      actionVariant: "outline",
      descriptionKey: null,
      host: "my.stll.app",
      status: "linked",
      statusKey: "accountLinked",
    });
  });

  test("a missing account offers connecting to the named server", () => {
    expect(
      accountPresentation({ status: "disconnected", server: SERVER }),
    ).toEqual({
      actionKey: "connectToHost",
      actionVariant: "default",
      descriptionKey: "connectToHostDescription",
      host: "my.stll.app",
      status: "not-linked",
      statusKey: "notConnected",
    });
  });

  test("an expired account asks for attention and offers reconnecting", () => {
    expect(accountPresentation({ status: "expired", server: SERVER })).toEqual({
      actionKey: "reconnect",
      actionVariant: "default",
      descriptionKey: "reconnectHostDescription",
      host: "my.stll.app",
      status: "attention",
      statusKey: "connectionExpired",
    });
  });

  test("an unavailable device key asks for attention, not a lookup retry", () => {
    expect(
      accountPresentation({ status: "reconnectRequired", server: SERVER }),
    ).toEqual({
      actionKey: "reconnect",
      actionVariant: "default",
      descriptionKey: "reconnectHostDescription",
      host: "my.stll.app",
      status: "attention",
      statusKey: "reconnectNeeded",
    });
  });

  test("an account read failure never presents the account as disconnected", () => {
    expect(accountPresentation({ status: "unavailable" })).toEqual({
      actionKey: "tryAgain",
      actionVariant: "outline",
      descriptionKey: "errorReadAccount",
      host: null,
      status: "unavailable",
      statusKey: "notAvailableYet",
    });
  });

  test("the server reads as the host a person recognises", () => {
    expect(serverHost("http://localhost:3332")).toBe("localhost:3332");
    expect(serverHost("not a url")).toBe("not a url");
  });
});

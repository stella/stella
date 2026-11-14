import { describe, expect, test } from "bun:test";

import {
  desktopAccountConnectUrl,
  parseDesktopLinkStatus,
  signedDesktopLinkStatus,
} from "./desktop-account-link";
import type { DesktopLinkIntent } from "./desktop-account-link";
import fixtures from "./desktop-account-link.fixtures.json";
import {
  DESKTOP_ACCOUNT_LINK_PROTOCOL,
  DESKTOP_LINK_FAILURE_REASON_PROTOCOL,
  readDesktopLinkProtocol,
} from "./desktop-registry";
import type { DesktopLinkFailure } from "./desktop-rpc.gen";

// The desktop app's Rust tests read the same fixture, so both sides agree on
// the links the page opens and the statuses the app signs.
const ALL_FAILURES = {
  account_conflict: "account_conflict",
  switch_declined: "switch_declined",
  declined: "declined",
  update_required: "update_required",
  unavailable: "unavailable",
} as const satisfies { [Reason in DesktopLinkFailure]: Reason };

const INTENTS = {
  connect: "connect",
  switch: "switch",
} as const satisfies { [Intent in DesktopLinkIntent]: Intent };

const CURRENT = DESKTOP_ACCOUNT_LINK_PROTOCOL.current;
// The installed desktop that predates failure reasons.
const BEFORE_REASONS = DESKTOP_LINK_FAILURE_REASON_PROTOCOL - 1;

describe("desktop account link contract", () => {
  test("the page opens exactly the connect links the app parses", () => {
    expect(
      fixtures.connectLinks.map(({ intent }) => intent).toSorted(),
    ).toEqual(Object.values(INTENTS).toSorted());
    for (const {
      apiBaseUrl,
      webOrigin,
      intent,
      url,
    } of fixtures.connectLinks) {
      const typed = Object.values(INTENTS).find((known) => known === intent);
      expect(typed).toBeDefined();
      if (typed === undefined) {
        continue;
      }
      expect(
        desktopAccountConnectUrl({ apiBaseUrl, webOrigin, intent: typed }),
      ).toBe(url);
    }
  });

  test("every status the app can sign parses back with its signed line", () => {
    const reasons = fixtures.connectionStatuses.flatMap(({ payload }) =>
      "reason" in payload ? [payload.reason] : [],
    );
    expect(reasons.toSorted()).toEqual(Object.values(ALL_FAILURES).toSorted());
    for (const { payload, signed } of fixtures.connectionStatuses) {
      const status = parseDesktopLinkStatus(payload, CURRENT);
      expect(status).not.toBeNull();
      if (status === null) {
        continue;
      }
      expect(payload).toEqual(status);
      expect(signedDesktopLinkStatus(status, CURRENT)).toBe(signed);
    }
  });

  test("a failure without a known reason is outside the contract", () => {
    for (const payload of [
      { status: "failed" },
      { status: "failed", reason: "account_mismatch" },
      { status: "failed", reason: "toString" },
      { status: "refused", reason: "account_conflict" },
    ]) {
      expect(parseDesktopLinkStatus(payload, CURRENT)).toBeNull();
    }
  });

  test("an installed desktop from before failure reasons still links", () => {
    expect(BEFORE_REASONS).toBe(DESKTOP_ACCOUNT_LINK_PROTOCOL.minimum);
    expect(readDesktopLinkProtocol(String(BEFORE_REASONS))).toBe(
      BEFORE_REASONS,
    );
    for (const payload of [
      { status: "pending" },
      { status: "connected" },
    ] as const) {
      expect(parseDesktopLinkStatus(payload, BEFORE_REASONS)).toEqual(payload);
    }
    // Its bare failure names no reason: the page reports it as unavailable,
    // signed as the line that desktop signs, and never offers a switch.
    const failed = parseDesktopLinkStatus({ status: "failed" }, BEFORE_REASONS);
    expect(failed).toEqual({ status: "failed", reason: "unavailable" });
    if (failed !== null) {
      expect(signedDesktopLinkStatus(failed, BEFORE_REASONS)).toBe("failed");
    }
    expect(
      parseDesktopLinkStatus(
        { status: "failed", reason: "account_conflict" },
        BEFORE_REASONS,
      ),
    ).toBeNull();
  });

  test("only the accepted link protocols read as one", () => {
    expect(readDesktopLinkProtocol(String(CURRENT))).toBe(CURRENT);
    for (const value of [
      null,
      "",
      String(DESKTOP_ACCOUNT_LINK_PROTOCOL.minimum - 1),
      String(CURRENT + 1),
      `0${String(CURRENT)}`,
      `${String(CURRENT)}.0`,
      "invalid",
    ]) {
      expect(readDesktopLinkProtocol(value)).toBeNull();
    }
  });
});

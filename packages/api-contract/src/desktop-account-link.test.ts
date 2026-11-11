import { describe, expect, test } from "bun:test";

import {
  desktopAccountConnectUrl,
  parseDesktopLinkStatus,
  signedDesktopLinkStatus,
} from "./desktop-account-link";
import type { DesktopLinkIntent } from "./desktop-account-link";
import fixtures from "./desktop-account-link.fixtures.json";
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
      const status = parseDesktopLinkStatus(payload);
      expect(status).not.toBeNull();
      if (status === null) {
        continue;
      }
      expect(payload).toEqual(status);
      expect(signedDesktopLinkStatus(status)).toBe(signed);
    }
  });

  test("a failure without a known reason is outside the contract", () => {
    for (const payload of [
      { status: "failed" },
      { status: "failed", reason: "account_mismatch" },
      { status: "failed", reason: "toString" },
      { status: "refused", reason: "account_conflict" },
    ]) {
      expect(parseDesktopLinkStatus(payload)).toBeNull();
    }
  });
});

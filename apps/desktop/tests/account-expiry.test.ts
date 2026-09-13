import { expect, test } from "bun:test";

import { accountExpiryDelay } from "../src/shared/account-expiry";

test("account expiry refreshes at the remaining lifetime and immediately once stale", () => {
  const expiresAt = "2026-09-19T20:00:00Z";
  expect(
    accountExpiryDelay(expiresAt, Date.parse("2026-09-19T19:59:00Z")),
  ).toBe(60_000);
  expect(
    accountExpiryDelay(expiresAt, Date.parse("2026-09-19T20:01:00Z")),
  ).toBe(0);
});

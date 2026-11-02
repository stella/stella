import { describe, expect, test } from "bun:test";

import {
  classifyInvitation,
  type InvitationStatus,
  isInvitationStatus,
} from "./invitation-sections";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const PAST = new Date("2026-10-29T12:00:00.000Z");
const FUTURE = new Date("2026-10-31T12:00:00.000Z");

const CASES = {
  pending: {
    expired: { section: "past", status: "expired" },
    open: { section: "pending", status: "pending" },
  },
  accepted: {
    expired: { section: "hidden", status: "accepted" },
    open: { section: "hidden", status: "accepted" },
  },
  rejected: {
    expired: { section: "past", status: "rejected" },
    open: { section: "past", status: "rejected" },
  },
  canceled: {
    expired: { section: "past", status: "canceled" },
    open: { section: "past", status: "canceled" },
  },
} as const satisfies Record<
  InvitationStatus,
  Record<"expired" | "open", ReturnType<typeof classifyInvitation>>
>;

describe("invitation sections", () => {
  for (const [status, expected] of Object.entries(CASES)) {
    if (!isInvitationStatus(status)) {
      throw new TypeError(`Unknown invitation status fixture: ${status}`);
    }
    for (const expiry of ["expired", "open"] as const) {
      const expiresAt = expiry === "expired" ? PAST : FUTURE;
      test(`${status} invitations with ${expiry} expiry use their assigned section`, () => {
        expect(classifyInvitation({ status, expiresAt }, NOW)).toEqual(
          expected[expiry],
        );
      });
    }
  }

  test("pending invitations expire at their expiry instant", () => {
    expect(
      classifyInvitation({ status: "pending", expiresAt: NOW }, NOW),
    ).toEqual({ section: "past", status: "expired" });
  });

  test("serialized expiry dates use the same section as dates", () => {
    expect(
      classifyInvitation(
        { status: "pending", expiresAt: PAST.toISOString() },
        NOW,
      ),
    ).toEqual({ section: "past", status: "expired" });
  });
});

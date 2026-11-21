import { describe, expect, test } from "bun:test";

import { SESSION_SIGN_IN_REVIEW } from "@stll/api-contract/session-sign-ins";
import { DEVICE_KIND } from "@stll/user-agent";

import {
  type ListedSession,
  type ListedSignIn,
  otherDevices,
  pendingReviews,
  reviewCardState,
  signedInDevices,
} from "./-account.security.logic";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const session = (
  id: string,
  userAgent: string,
  lastActiveMinute: number,
): ListedSession => ({
  id,
  userAgent,
  ipAddress: "198.51.100.7",
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
  updatedAt: new Date(Date.UTC(2026, 10, 20, 11, lastActiveMinute)),
  originClientName: null,
});

const BRATISLAVA = {
  type: "known",
  countryCode: "SK",
  region: null,
  city: "Bratislava",
  coordinates: { latitude: 48.1, longitude: 17.1 },
} as const;

const SESSIONS = [
  session("this-mac", MAC_CHROME, 30),
  session("phone", IPHONE, 10),
  session("older-mac", MAC_CHROME, 20),
];

const SIGN_INS: ListedSignIn[] = [
  {
    id: "phone",
    location: BRATISLAVA,
    review: SESSION_SIGN_IN_REVIEW.pending,
  },
  {
    id: "this-mac",
    location: { type: "unknown" },
    review: SESSION_SIGN_IN_REVIEW.notRequired,
  },
];

describe("signed-in devices", () => {
  test("joins every session with its sign-in, newest activity first", () => {
    const devices = signedInDevices(SESSIONS, SIGN_INS);

    expect(devices.map(({ id }) => id)).toEqual([
      "this-mac",
      "older-mac",
      "phone",
    ]);
    expect(devices.find(({ id }) => id === "phone")).toMatchObject({
      kind: DEVICE_KIND.phone,
      name: { type: "browserOnOs", browser: "Safari", os: "iOS" },
      location: BRATISLAVA,
      review: SESSION_SIGN_IN_REVIEW.pending,
    });
  });

  test("a session the sign-in list has not seen reads as unknown and unreviewed", () => {
    const devices = signedInDevices(SESSIONS, SIGN_INS);

    expect(devices.find(({ id }) => id === "older-mac")).toMatchObject({
      location: { type: "unknown" },
      review: SESSION_SIGN_IN_REVIEW.notRequired,
    });
  });

  test("other devices leave this one out and put sign-ins to review first", () => {
    const devices = signedInDevices(SESSIONS, SIGN_INS);

    expect(otherDevices(devices, "this-mac").map(({ id }) => id)).toEqual([
      "phone",
      "older-mac",
    ]);
    expect(pendingReviews(devices).map(({ id }) => id)).toEqual(["phone"]);
  });
});

describe("the review card", () => {
  const devices = signedInDevices(SESSIONS, SIGN_INS);

  test("asks about a pending sign-in the link names", () => {
    expect(
      reviewCardState({
        targetSessionId: "phone",
        devices,
        outcome: { type: "undecided" },
      }),
    ).toMatchObject({ type: "ask", device: { id: "phone" } });
  });

  test("shows a confirmed sign-in collapsed, so it can be undone", () => {
    const confirmed = signedInDevices(SESSIONS, [
      {
        id: "phone",
        location: BRATISLAVA,
        review: SESSION_SIGN_IN_REVIEW.confirmed,
      },
    ]);

    expect(
      reviewCardState({
        targetSessionId: "phone",
        devices: confirmed,
        outcome: { type: "undecided" },
      }),
    ).toMatchObject({ type: "confirmed" });
  });

  test("remembers a device it signed out after the list drops it", () => {
    const remaining = devices.filter(({ id }) => id !== "phone");

    expect(
      reviewCardState({
        targetSessionId: "phone",
        devices: remaining,
        outcome: {
          type: "signedOut",
          deviceName: { type: "browserOnOs", browser: "Safari", os: "iOS" },
        },
      }),
    ).toEqual({
      type: "signedOut",
      deviceName: { type: "browserOnOs", browser: "Safari", os: "iOS" },
    });
    expect(
      reviewCardState({
        targetSessionId: "phone",
        devices: remaining,
        outcome: { type: "undecided" },
      }),
    ).toEqual({ type: "gone" });
  });

  test("shows nothing without a target or for a sign-in that needs no review", () => {
    for (const targetSessionId of [undefined, "older-mac"]) {
      expect(
        reviewCardState({
          targetSessionId,
          devices,
          outcome: { type: "undecided" },
        }),
      ).toEqual({ type: "none" });
    }
  });
});

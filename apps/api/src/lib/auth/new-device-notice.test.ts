import { describe, expect, test } from "bun:test";

import { sendNewDeviceNotice } from "@/api/lib/auth/new-device-notice";
import { toSafeId } from "@/api/lib/branded-types";

const newSession = {
  user: {
    id: toSafeId<"user">("user-1"),
    email: "person@example.com",
  },
  session: {
    id: "session-2",
    ipAddress: "203.0.113.2",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    createdAt: new Date("2026-10-19T12:00:00.000Z"),
  },
};

const previousSessions = [
  {
    ipAddress: "203.0.113.1",
    userAgent: newSession.session.userAgent,
  },
];

const createDependencies = () => {
  const notices: unknown[] = [];
  let lookupCount = 0;
  return {
    notices,
    getLookupCount: () => lookupCount,
    dependencies: {
      findPreviousSessions: async () => {
        lookupCount += 1;
        return previousSessions;
      },
      sendNotice: (notice: unknown) => notices.push(notice),
      isTransactionalEmailConfigured: () => true,
      isLocalDev: () => false,
      onError: (error: unknown) => {
        throw error;
      },
    },
  };
};

describe("new-device notices", () => {
  test("sends one notice after a completed TOTP challenge", async () => {
    const { dependencies, notices, getLookupCount } = createDependencies();

    await sendNewDeviceNotice({
      path: "/two-factor/verify-totp",
      newSession,
      dependencies,
    });

    expect(getLookupCount()).toBe(1);
    expect(notices).toHaveLength(1);
  });

  test("sends no notice while an email-code second factor is pending", async () => {
    const { dependencies, notices, getLookupCount } = createDependencies();

    await sendNewDeviceNotice({
      path: "/sign-in/email-otp",
      newSession: null,
      dependencies,
    });

    expect(getLookupCount()).toBe(0);
    expect(notices).toHaveLength(0);
  });

  test("sends for email sign-in but not for a non-session path", async () => {
    const emailSignIn = createDependencies();
    await sendNewDeviceNotice({
      path: "/sign-in/email",
      newSession,
      dependencies: emailSignIn.dependencies,
    });

    const noSessionPath = createDependencies();
    await sendNewDeviceNotice({
      path: "/verify-email",
      newSession,
      dependencies: noSessionPath.dependencies,
    });

    expect(emailSignIn.notices).toHaveLength(1);
    expect(noSessionPath.getLookupCount()).toBe(0);
    expect(noSessionPath.notices).toHaveLength(0);
  });
});

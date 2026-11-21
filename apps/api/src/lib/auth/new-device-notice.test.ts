import { describe, expect, test } from "bun:test";

import { sendNewDeviceNotice } from "@/api/lib/auth/new-device-notice";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";

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

type ReviewOutcome = "marked" | "failed";

const createDependencies = (reviewOutcome: ReviewOutcome = "marked") => {
  const notices: unknown[] = [];
  const reviews: string[] = [];
  const errors: unknown[] = [];
  let lookupCount = 0;
  return {
    notices,
    reviews,
    errors,
    getLookupCount: () => lookupCount,
    dependencies: {
      findPreviousSessions: async () => {
        lookupCount += 1;
        return previousSessions;
      },
      requestReview: async ({
        userId,
        sessionId,
      }: {
        userId: SafeId<"user">;
        sessionId: string;
      }) => {
        if (reviewOutcome === "failed") {
          throw new Error("review store unavailable");
        }
        reviews.push(`${userId}/${sessionId}`);
      },
      sendNotice: (notice: unknown) => notices.push(notice),
      isTransactionalEmailConfigured: () => true,
      isLocalDev: () => false,
      onError: (error: unknown) => {
        if (reviewOutcome === "failed") {
          errors.push(error);
          return;
        }
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

  test.each([
    {
      userAgent: newSession.session.userAgent,
      ipAddress: "203.0.113.2",
      device: { type: "browserOnOs", browser: "Chrome", os: "macOS" },
      address: { type: "known", address: "203.0.113.2" },
    },
    {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      ipAddress: null,
      device: { type: "os", os: "Windows" },
      address: { type: "unknown" },
    },
    {
      userAgent: "curl/8.7.1",
      ipAddress: "203.0.113.2",
      device: { type: "unknown" },
      address: { type: "known", address: "203.0.113.2" },
    },
  ])(
    "describes the device and address as data, leaving wording to the email: $device",
    async ({ userAgent, ipAddress, device, address }) => {
      const { dependencies, notices } = createDependencies();

      await sendNewDeviceNotice({
        path: "/two-factor/verify-totp",
        newSession: {
          ...newSession,
          session: { ...newSession.session, userAgent, ipAddress },
        },
        dependencies,
      });

      expect(notices).toEqual([
        expect.objectContaining({ device, ipAddress: address }),
      ]);
    },
  );

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

  test("marks the reported sign-in for review, and only that one", async () => {
    const reported = createDependencies();
    await sendNewDeviceNotice({
      path: "/two-factor/verify-totp",
      newSession,
      dependencies: reported.dependencies,
    });

    const known = createDependencies();
    await sendNewDeviceNotice({
      path: "/two-factor/verify-totp",
      newSession: {
        ...newSession,
        session: { ...newSession.session, ipAddress: "203.0.113.1" },
      },
      dependencies: known.dependencies,
    });

    expect(reported.reviews).toEqual(["user-1/session-2"]);
    expect(reported.notices).toHaveLength(1);
    expect(known.reviews).toEqual([]);
    expect(known.notices).toHaveLength(0);
  });

  test("still sends the notice when the review cannot be recorded", async () => {
    const { dependencies, notices, errors } = createDependencies("failed");

    await sendNewDeviceNotice({
      path: "/two-factor/verify-totp",
      newSession,
      dependencies,
    });

    expect(notices).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { session as authSession } from "@/api/db/auth-schema";
import { meRoute } from "@/api/handlers/me/routes";
import { AUTH_REJECTION_BODY, getAuth } from "@/api/lib/auth";
import { SESSION_ABSOLUTE_AGE_MS } from "@/api/lib/auth/session-liveness";
import { toSafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const routeServer = serveRoutesForTest(meRoute);
afterAll(async () => {
  await routeServer.stop();
});

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const requestAccountRoute = async (browser: HumanBrowser) =>
  await routeServer.fetch(
    new Request("http://localhost/me/professional-use", {
      headers: { cookie: browser.cookieHeader() },
    }),
  );

const signIn = async () =>
  await signInHuman(`account-${Bun.randomUUIDv7()}@stella.dev`);

const expectAuthRejection = async (response: Response, status: 401 | 500) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(AUTH_REJECTION_BODY[status]);
};

describe("account-route session liveness", () => {
  test("a signed-in request with a live stored session succeeds", async () => {
    const browser = await signIn();

    const response = await requestAccountRoute(browser);

    expect(response.status).toBe(200);
  });

  test("refuses a cached cookie after its stored session is deleted", async () => {
    const browser = await signIn();
    expect((await requestAccountRoute(browser)).status).toBe(200);

    const otherDevice = await signInHuman(browser.email);
    await getAuth().api.revokeOtherSessions({ headers: otherDevice.headers() });

    await expectAuthRejection(await requestAccountRoute(browser), 401);
    // The device that signed the others out keeps its own session.
    expect((await requestAccountRoute(otherDevice)).status).toBe(200);
  });

  test("refuses a cached cookie after its stored session expires", async () => {
    const browser = await signIn();
    expect((await requestAccountRoute(browser)).status).toBe(200);

    await testDb
      .update(authSession)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSession.userId, browser.userId));

    await expectAuthRejection(await requestAccountRoute(browser), 401);
  });

  test("refuses a cached cookie at the absolute cap while expiry is still in the future", async () => {
    const browser = await signIn();
    expect((await requestAccountRoute(browser)).status).toBe(200);
    await testDb
      .update(authSession)
      .set({
        createdAt: new Date(Date.now() - SESSION_ABSOLUTE_AGE_MS - 1),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(authSession.userId, browser.userId));
    await expectAuthRejection(await requestAccountRoute(browser), 401);
  });

  test("refuses a cached cookie after deleting its user cascades the session", async () => {
    const browser = await signIn();
    expect((await requestAccountRoute(browser)).status).toBe(200);

    const code = await createConfirmationOtp({
      purpose: "delete-account",
      email: browser.email,
    });
    if (Result.isError(code)) {
      panic(code.error.message);
    }
    const deleted = await verifyAndDeleteUser(
      toSafeId<"user">(browser.userId),
      browser.email,
      code.value,
    );
    if (Result.isError(deleted)) {
      panic(deleted.error.message);
    }

    await expectAuthRejection(await requestAccountRoute(browser), 401);
  });

  test("returns only the generic auth error when the liveness read fails", async () => {
    const browser = await signIn();
    const { adapter } = await getAuth().$context;
    const lookup = spyOn(adapter, "findOne").mockRejectedValueOnce(
      new Error("injected session liveness failure"),
    );

    try {
      const response = await requestAccountRoute(browser);

      await expectAuthRejection(response, 500);
    } finally {
      lookup.mockRestore();
    }
  });

  test("performs exactly one stored-session liveness read", async () => {
    const browser = await signIn();
    const { adapter } = await getAuth().$context;
    const lookup = spyOn(adapter, "findOne");

    try {
      const response = await requestAccountRoute(browser);
      const sessionReads = lookup.mock.calls.filter(
        ([input]) => input.model === "session",
      );

      expect(response.status).toBe(200);
      expect(sessionReads).toHaveLength(1);
    } finally {
      lookup.mockRestore();
    }
  });
});

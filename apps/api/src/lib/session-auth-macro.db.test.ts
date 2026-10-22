import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import Elysia from "elysia";

import { getAuth, sessionAuthMacro } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

// Account routes (`validateSession`) answer from the stored session, so the
// request right after a session or an account ends is refused, even while the
// browser still holds its signed session snapshot cookie.

setDefaultTimeout(120_000);

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const accountRoute = new Elysia()
  .use(sessionAuthMacro)
  .get("/me/probe", () => "ok", { validateSession: true });

const accountRouteStatus = async (browser: HumanBrowser) =>
  (
    await accountRoute.handle(
      new Request("http://localhost/me/probe", {
        headers: { cookie: browser.cookieHeader() },
      }),
    )
  ).status;

describe("account routes", () => {
  test("refuse a session signed out from another device", async () => {
    const email = `account-${Bun.randomUUIDv7()}@stella.dev`;
    const browser = await signInHuman(email);
    expect(await accountRouteStatus(browser)).toBe(200);

    const otherDevice = await signInHuman(email);
    await getAuth().api.revokeOtherSessions({ headers: otherDevice.headers() });

    expect(await accountRouteStatus(browser)).toBe(401);
    expect(await accountRouteStatus(otherDevice)).toBe(200);
  });

  test("refuse a deleted account", async () => {
    const email = `account-${Bun.randomUUIDv7()}@stella.dev`;
    const browser = await signInHuman(email);
    expect(await accountRouteStatus(browser)).toBe(200);

    const code = await createConfirmationOtp({
      purpose: "delete-account",
      email,
    });
    if (Result.isError(code)) {
      panic(code.error.message);
    }
    const deleted = await verifyAndDeleteUser(
      toSafeId<"user">(browser.userId),
      email,
      code.value,
    );
    if (Result.isError(deleted)) {
      panic(deleted.error.message);
    }

    expect(await accountRouteStatus(browser)).toBe(401);
  });
});

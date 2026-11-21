import { APIError } from "@better-auth/core/error";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { isPendingTwoFactorSignIn } from "@/api/lib/auth-artifacts";
import {
  DISCONNECTED_SIGN_IN_MESSAGE,
  endSessionWithoutLinkedAccount,
  firstFactorRequirement,
  isSecondFactorCompletion,
  NO_LINKED_ACCOUNT,
  recordSecondFactorRequirement,
  secondFactorRequirement,
  sessionLinkedAccountRequirement,
  signInAccountProvider,
} from "@/api/lib/auth/sign-in-account-provider";
import { toSafeId } from "@/api/lib/branded-types";

const email = "account@example.test";
const password = "correct horse battery staple";

type Written = "session" | "pending second factor" | "completed second factor";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The text an RFC 4648 base32 authenticator secret encodes. */
const decodeBase32Text = (encoded: string): string => {
  // Base32 is ASCII, so each UTF-16 unit is one symbol.
  const symbols = encoded.replaceAll("=", "").toUpperCase();
  const bitString = Array.from({ length: symbols.length }, (_unused, at) =>
    symbols.charAt(at),
  )
    .map((symbol) => {
      const index = BASE32_ALPHABET.indexOf(symbol);
      return index === -1
        ? panic(`Invalid base32 symbol: ${symbol}`)
        : index.toString(2).padStart(5, "0");
    })
    .join("");
  const byteCount = Math.floor(bitString.length / 8);
  const bytes = Array.from({ length: byteCount }, (_unused, byte) =>
    Number.parseInt(bitString.slice(byte * 8, byte * 8 + 8), 2),
  );
  return new TextDecoder().decode(Uint8Array.from(bytes));
};

/**
 * Authenticator enrollment as Better Auth ships it (verification required),
 * with the production session hook: the signed-in user verifies a real TOTP
 * code, which rotates their session.
 */
const enrollAuthenticator = async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [twoFactor()],
    databaseHooks: {
      session: {
        create: {
          after: async (session, ctx) => {
            const ended = await endSessionWithoutLinkedAccount({
              requirement: await sessionLinkedAccountRequirement(ctx),
              userId: toSafeId<"user">(session.userId),
              hasAccount: async (userId, providerId) => {
                const context = await auth.$context;
                const accounts =
                  await context.internalAdapter.findAccounts(userId);
                return accounts.some(
                  (account) => account.providerId === providerId,
                );
              },
              endSession: async () => {
                await ctx?.context.internalAdapter.deleteSession(session.token);
              },
            });
            if (ended) {
              throw new APIError("UNAUTHORIZED", {
                message: DISCONNECTED_SIGN_IN_MESSAGE,
              });
            }
          },
        },
      },
    },
  });
  const cookiesOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  await auth.api.signUpEmail({ body: { email, password, name: "Account" } });
  const signedIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = cookiesOf(signedIn);
  const enabled = await auth.api.enableTwoFactor({
    body: { password },
    headers: new Headers({ cookie }),
  });
  if (enabled.method !== "totp") {
    panic("Two-factor enrolment did not return an authenticator URI");
  }
  const encodedSecret =
    new URL(enabled.totpURI).searchParams.get("secret") ??
    panic("Authenticator URI has no secret");
  const { code } = await auth.api.generateTOTP({
    body: { secret: decodeBase32Text(encodedSecret) },
  });
  const verified = await auth.handler(
    new Request("http://localhost:3001/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ code }),
    }),
  );
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookiesOf(verified) || cookie }),
  });
  return { verified, session };
};

/**
 * A password sign-in through Better Auth with the production session and
 * pending second-factor hooks and the cookie cache. With `reset.before` set,
 * an access reset removes the account's linked accounts after the sign-in
 * wrote that row and before its check.
 */
const createPasswordSignIn = async ({
  secondFactor = false,
}: { secondFactor?: boolean } = {}) => {
  const reset: { before: Written | null } = { before: null };
  const linkedAfterReset = async (
    written: Written,
    userId: string,
    providerId: string,
  ) => {
    const context = await auth.$context;
    if (reset.before === written) {
      for (const account of await context.internalAdapter.findAccounts(
        userId,
      )) {
        await context.internalAdapter.deleteAccount(account.id);
      }
    }
    const accounts = await context.internalAdapter.findAccounts(userId);
    return accounts.some((account) => account.providerId === providerId);
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
    }),
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: true, maxAge: 300 } },
    plugins: [twoFactor({ skipVerificationOnEnable: true })],
    // The production hooks in lib/auth.ts, over this fixture's store.
    databaseHooks: {
      verification: {
        create: {
          after: async (row, ctx) => {
            if (!ctx || !isPendingTwoFactorSignIn(row.identifier)) {
              return;
            }
            const requirement = firstFactorRequirement(ctx);
            const ended = await endSessionWithoutLinkedAccount({
              requirement,
              userId: toSafeId<"user">(row.value),
              hasAccount: async (userId, providerId) =>
                await linkedAfterReset(
                  "pending second factor",
                  userId,
                  providerId,
                ),
              endSession: async () => {
                await ctx.context.internalAdapter.deleteVerificationByIdentifier(
                  row.identifier,
                );
              },
            });
            if (ended) {
              throw new APIError("UNAUTHORIZED", {
                message: DISCONNECTED_SIGN_IN_MESSAGE,
              });
            }
            await recordSecondFactorRequirement(ctx, { row, requirement });
          },
        },
      },
      session: {
        create: {
          after: async (session, ctx) => {
            const ended = await endSessionWithoutLinkedAccount({
              requirement: await sessionLinkedAccountRequirement(ctx),
              userId: toSafeId<"user">(session.userId),
              hasAccount: async (userId, providerId) =>
                await linkedAfterReset(
                  isSecondFactorCompletion(ctx)
                    ? "completed second factor"
                    : "session",
                  userId,
                  providerId,
                ),
              endSession: async () => {
                await ctx?.context.internalAdapter.deleteSession(session.token);
              },
            });
            if (ended) {
              throw new APIError("UNAUTHORIZED", {
                message: DISCONNECTED_SIGN_IN_MESSAGE,
              });
            }
          },
        },
      },
    },
  });
  const signedUp = await auth.api.signUpEmail({
    body: { email, password, name: "Account" },
  });
  const userId = signedUp.user.id;
  const context = await auth.$context;
  const cookiesOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  const backupCodes: string[] = [];
  if (secondFactor) {
    const signedIn = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const enabled = await auth.api.enableTwoFactor({
      body: { password },
      headers: new Headers({ cookie: cookiesOf(signedIn) }),
    });
    if (enabled.method !== "totp") {
      panic("Two-factor enrolment did not return backup codes");
    }
    backupCodes.push(...enabled.backupCodes);
  }
  const completeSecondFactor = async (pending: Response) =>
    await auth.handler(
      new Request(
        "http://localhost:3001/api/auth/two-factor/verify-backup-code",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: cookiesOf(pending),
          },
          body: JSON.stringify({
            code: backupCodes.at(0) ?? panic("Backup code fixture missing"),
          }),
        },
      ),
    );
  const pendingSecondFactors = async () =>
    (
      await context.adapter.findMany<{ identifier: string }>({
        model: "verification",
      })
    ).filter(({ identifier }) => isPendingTwoFactorSignIn(identifier));
  const signIn = async () =>
    await auth.handler(
      new Request("http://localhost:3001/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  const sessionFor = async (response: Response) =>
    await auth.api.getSession({
      headers: new Headers({ cookie: cookiesOf(response) }),
    });
  const sessionCount = async () =>
    (await context.internalAdapter.listSessions(userId)).length;
  return {
    reset,
    signIn,
    completeSecondFactor,
    sessionFor,
    sessionCount,
    pendingSecondFactors,
  };
};

type Step = "insert" | "check" | "deleteAccounts" | "deleteSessions";

/** Every order of two sequences that keeps each sequence's own order. */
const interleavings = (
  left: readonly Step[],
  right: readonly Step[],
): Step[][] => {
  const [leftHead, ...leftRest] = left;
  const [rightHead, ...rightRest] = right;
  if (leftHead === undefined) {
    return [[...right]];
  }
  if (rightHead === undefined) {
    return [[...left]];
  }
  return [
    ...interleavings(leftRest, right).map((order) => [leftHead, ...order]),
    ...interleavings(left, rightRest).map((order) => [rightHead, ...order]),
  ];
};

/**
 * A provider sign-in racing an access reset over one account, with each step
 * atomic: whether the sign-in's session is still live once both finish.
 */
const sessionSurvives = async (order: readonly Step[]): Promise<boolean> => {
  const linkedAccounts = new Set(["google"]);
  const sessions = new Set<string>();
  const check = async () =>
    await endSessionWithoutLinkedAccount({
      requirement: firstFactorRequirement({ path: "/callback/google" }),
      userId: toSafeId<"user">("user_1"),
      hasAccount: async (_userId, providerId) =>
        await Promise.resolve(linkedAccounts.has(providerId)),
      endSession: async () => {
        sessions.delete("new");
        await Promise.resolve();
      },
    });
  for (const step of order) {
    switch (step) {
      case "insert":
        sessions.add("new");
        break;
      case "check":
        await check();
        break;
      case "deleteAccounts":
        linkedAccounts.clear();
        break;
      case "deleteSessions":
        sessions.clear();
        break;
      default:
        step satisfies never;
    }
  }
  return sessions.has("new");
};

describe("sign-in account provider", () => {
  test.each([
    [{ path: "/callback/google" }, "google"],
    [{ path: "/callback/microsoft" }, "microsoft"],
    [{ path: "/callback/:id", params: { id: "google" } }, "google"],
    [{ path: "/sign-in/email" }, "credential"],
  ])("a session from %j needs its %s account", (ctx, provider) => {
    expect(signInAccountProvider(ctx)).toBe(provider);
  });

  test.each([
    [{ path: "/sign-in/email-otp" }],
    [{ path: "/sign-up/email" }],
    [{ path: "/" }],
    [{}],
    [null],
    [undefined],
  ])("a session from %j needs no linked account", (ctx) => {
    expect(signInAccountProvider(ctx)).toBeUndefined();
  });

  test("no interleaving with an access reset leaves the sign-in's session live", async () => {
    const orders = interleavings(
      ["insert", "check"],
      ["deleteAccounts", "deleteSessions"],
    );
    expect(orders).toHaveLength(6);
    for (const order of orders) {
      expect({ order, survives: await sessionSurvives(order) }).toEqual({
        order,
        survives: false,
      });
    }
  });

  test("a check before the insert would let a paused sign-in survive", async () => {
    // The order the check runs after the insert to exclude.
    expect(
      await sessionSurvives([
        "check",
        "deleteAccounts",
        "deleteSessions",
        "insert",
      ]),
    ).toBe(true);
  });

  test("a sign-in whose account is still linked keeps its session", async () => {
    expect(await sessionSurvives(["insert", "check"])).toBe(true);
  });

  test("a password sign-in whose account a reset removed gets no session and no cookie", async () => {
    const fixture = await createPasswordSignIn();
    const sessionsBefore = await fixture.sessionCount();
    fixture.reset.before = "session";
    const response = await fixture.signIn();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: DISCONNECTED_SIGN_IN_MESSAGE,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await fixture.sessionFor(response)).toBeNull();
    expect(await fixture.sessionCount()).toBe(sessionsBefore);
  });

  test("a password sign-in with its account linked is signed in by its cookies", async () => {
    const fixture = await createPasswordSignIn();
    const response = await fixture.signIn();
    expect(response.status).toBe(200);
    expect((await fixture.sessionFor(response))?.user.email).toBe(email);
  });

  test("a password sign-in with a second factor leaves it pending while its account is linked", async () => {
    const fixture = await createPasswordSignIn({ secondFactor: true });
    const response = await fixture.signIn();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await fixture.pendingSecondFactors()).toHaveLength(1);
  });

  test("a second factor left pending after a reset removed the account is refused and dropped", async () => {
    const fixture = await createPasswordSignIn({ secondFactor: true });
    fixture.reset.before = "pending second factor";
    const response = await fixture.signIn();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: DISCONNECTED_SIGN_IN_MESSAGE,
    });
    expect(
      response.headers
        .getSetCookie()
        .filter((cookie) => cookie.includes("two_factor")),
    ).toEqual([]);
    expect(await fixture.pendingSecondFactors()).toEqual([]);
    expect(await fixture.sessionFor(response)).toBeNull();
  });

  test("completing a second factor whose first factor a reset disconnected issues no session", async () => {
    const fixture = await createPasswordSignIn({ secondFactor: true });
    const pending = await fixture.signIn();
    expect(await pending.json()).toMatchObject({ twoFactorRedirect: true });
    // The reset lands after Better Auth consumed the challenge and wrote the
    // completing session, and before that session's check.
    fixture.reset.before = "completed second factor";
    const sessionsBefore = await fixture.sessionCount();
    const completed = await fixture.completeSecondFactor(pending);
    expect(completed.status).toBe(401);
    expect(await completed.json()).toMatchObject({
      message: DISCONNECTED_SIGN_IN_MESSAGE,
    });
    expect(await fixture.sessionFor(completed)).toBeNull();
    expect(await fixture.sessionCount()).toBe(sessionsBefore);
  });

  test("completing a second factor with its first factor linked signs the account in", async () => {
    const fixture = await createPasswordSignIn({ secondFactor: true });
    const pending = await fixture.signIn();
    const completed = await fixture.completeSecondFactor(pending);
    expect(completed.status).toBe(200);
    expect((await fixture.sessionFor(completed))?.user.email).toBe(email);
  });

  test.each([
    ["credential", { type: "linked", provider: "credential" }],
    [NO_LINKED_ACCOUNT, { type: "none" }],
    [undefined, { type: "unrecorded" }],
  ] as const)(
    "a second factor recorded as %j requires %j",
    (recorded, requirement) => {
      expect(secondFactorRequirement(recorded)).toEqual(requirement);
    },
  );

  test("a second factor with no recorded first factor is ended without a lookup", async () => {
    let lookups = 0;
    let ended = false;
    expect(
      await endSessionWithoutLinkedAccount({
        requirement: { type: "unrecorded" },
        userId: toSafeId<"user">("user_1"),
        hasAccount: async () => {
          lookups += 1;
          return await Promise.resolve(true);
        },
        endSession: async () => {
          ended = true;
          await Promise.resolve();
        },
      }),
    ).toBe(true);
    expect({ lookups, ended }).toEqual({ lookups: 0, ended: true });
  });

  test("a signed-in user's authenticator enrollment keeps its rotated session", async () => {
    const { verified, session } = await enrollAuthenticator();
    expect(verified.status).toBe(200);
    expect(session?.user.email).toBe(email);
    expect(session?.user.twoFactorEnabled).toBe(true);
  });

  test("a callback that names no provider is refused", () => {
    expect(() =>
      signInAccountProvider({ path: "/callback/:id", params: {} }),
    ).toThrow("Social sign-in callback without a provider");
  });
});

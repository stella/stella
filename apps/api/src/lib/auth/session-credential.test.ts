import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createSessionBearer } from "@/api/lib/auth/session-bearer";
import {
  carriesSessionCredential,
  skippableSessionCookieOf,
} from "@/api/lib/auth/session-credential";

const createTestAuth = ({ cookieCache }: { cookieCache: boolean }) =>
  betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: cookieCache, maxAge: 60 } },
    plugins: [createSessionBearer()],
  });

const signUp = async (auth: ReturnType<typeof createTestAuth>) => {
  const response = await auth.api.signUpEmail({
    body: {
      email: "account@example.test",
      name: "Account",
      password: "A secure password 123!",
    },
    asResponse: true,
  });
  const cookies = response.headers.getSetCookie().map((cookie) => {
    const pair = cookie.split(";", 1).at(0);
    return pair ?? panic("A set-cookie value has a name and value");
  });
  return cookies.join("; ");
};

describe("session credential skip", () => {
  test("skips exactly the requests Better Auth answers null without side effects", async () => {
    const auth = createTestAuth({ cookieCache: true });
    const sessionCookie = await skippableSessionCookieOf(auth);
    if (sessionCookie === null) {
      panic("A cookie-cached auth instance names a skippable session cookie");
    }
    const signedIn = await signUp(auth);
    const sessionToken = /(?:^|;\s*)[^=;]*session_token=([^;]+)/u
      .exec(signedIn)
      ?.at(1);
    if (sessionToken === undefined) {
      panic("Signing up sets the session cookie");
    }
    const cacheOnly = signedIn
      .split("; ")
      .filter((cookie) => !cookie.includes("session_token="))
      .join("; ");

    const requests: Record<string, Record<string, string>> = {
      none: {},
      unrelatedCookie: { cookie: "theme=dark; locale=en" },
      cacheCookieOnly: { cookie: cacheOnly },
      nearMissName: { cookie: `x${sessionCookie.slice(1)}=forged` },
      sessionCookie: { cookie: signedIn },
      bearer: {
        authorization: `Bearer ${decodeURIComponent(sessionToken)}`,
      },
      invalidBearer: { authorization: "Bearer invalid" },
    };

    for (const [name, init] of Object.entries(requests)) {
      const headers = new Headers(init);
      const resolved = await auth.api.getSession({
        headers,
        returnHeaders: true,
      });
      if (!carriesSessionCredential(headers, sessionCookie)) {
        expect(resolved.response, name).toBeNull();
        expect(resolved.headers.getSetCookie(), name).toEqual([]);
      }
      if (name === "sessionCookie" || name === "bearer") {
        expect(resolved.response, name).not.toBeNull();
      }
    }
    // The credentials themselves are never skipped.
    expect(
      carriesSessionCredential(
        new Headers(requests["sessionCookie"]),
        sessionCookie,
      ),
    ).toBe(true);
    expect(
      carriesSessionCredential(new Headers(requests["bearer"]), sessionCookie),
    ).toBe(true);
  });

  test("never skips when the cookie cache is off", async () => {
    expect(
      await skippableSessionCookieOf(createTestAuth({ cookieCache: false })),
    ).toBeNull();
  });
});

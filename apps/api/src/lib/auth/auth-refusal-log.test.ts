import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { describe, expect, test } from "bun:test";

import { describeAuthRefusal } from "@/api/lib/auth/auth-refusal-log";

describe("auth refusal log", () => {
  test("describes a refused token refresh by its protocol error", () => {
    expect(
      describeAuthRefusal({
        path: "/oauth2/token",
        returned: new APIError("BAD_REQUEST", {
          error: "invalid_scope",
          error_description: "scope not granted",
        }),
        body: {
          grant_type: "refresh_token",
          refresh_token: "secret-refresh-token",
          client_id: "client",
        },
      }),
    ).toEqual({
      type: "refused",
      attributes: {
        "auth.path": "/oauth2/token",
        "http.status_code": 400,
        "auth.error_code": "invalid_scope",
        "oauth.grant_type": "refresh_token",
      },
    });
  });

  test("keeps every logged value bounded", () => {
    expect(
      describeAuthRefusal({
        path: "/oauth2/token",
        returned: new APIError("UNAUTHORIZED", {
          error: "Not A Code: user@example.test",
        }),
        body: { grant_type: "custom-grant" },
      }),
    ).toEqual({
      type: "refused",
      attributes: {
        "auth.path": "/oauth2/token",
        "http.status_code": 401,
        "auth.error_code": "other",
      },
    });
    expect(
      describeAuthRefusal({
        path: "/sign-in/email",
        returned: new APIError("FORBIDDEN"),
        body: undefined,
      }),
    ).toMatchObject({
      type: "refused",
      attributes: { "auth.error_code": "unknown" },
    });
  });

  test("ignores successes, redirects and server errors", () => {
    for (const returned of [
      { ok: true },
      new APIError("FOUND", undefined, new Headers({ location: "/" })),
      new APIError("INTERNAL_SERVER_ERROR"),
    ]) {
      expect(
        describeAuthRefusal({ path: "/oauth2/token", returned, body: {} }),
      ).toEqual({ type: "answered" });
    }
  });

  test("logs a refused auth request through the plugin", async () => {
    const refusals: unknown[] = [];
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      emailAndPassword: { enabled: true },
      // The same after-hook `auth.ts` registers, logging to an array.
      plugins: [
        {
          id: "test-auth-refusal-log",
          hooks: {
            after: [
              {
                matcher: () => true,
                handler: createAuthMiddleware(async (ctx) => {
                  const refusal = describeAuthRefusal({
                    path: ctx.path,
                    returned: ctx.context.returned,
                    body: ctx.body,
                  });
                  if (refusal.type === "refused") {
                    refusals.push(refusal.attributes);
                  }
                  await Promise.resolve();
                }),
              },
            ],
          },
        },
      ],
    });

    const response = await auth.api.signInEmail({
      body: { email: "missing@example.test", password: "Wrong password 1!" },
      asResponse: true,
    });

    expect(response.status).toBe(401);
    expect(refusals).toEqual([
      {
        "auth.path": "/sign-in/email",
        "http.status_code": 401,
        "auth.error_code": "invalid_email_or_password",
      },
    ]);
  });
});

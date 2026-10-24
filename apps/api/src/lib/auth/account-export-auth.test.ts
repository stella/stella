import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import { createAccountExportAuthMacro } from "@/api/lib/auth";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import type { McpSession } from "@/api/mcp/auth";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";
import { PLAIN_MEMBER_FACTS } from "@/api/tests/helpers/member-authorization";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

const oauthSession = {
  userId: "user_one",
  organizationId: "org_one",
  memberId: "member_one",
  scopes: [ACCOUNT_EXPORT_SCOPES.read],
  credential: { type: "oauth_client", clientId: "client" },
} as const satisfies McpSession;

const memberAuthorization = {
  memberId: "member_one",
  email: "user@example.test",
  role: "owner",
  workspace: null,
  ...PLAIN_MEMBER_FACTS,
};

let analytics: RecordingAnalytics;
beforeEach(() => {
  analytics = installRecordingAnalytics();
});
afterEach(() => {
  analytics.restore();
});

describe("account export HTTP authentication", () => {
  test("read consent authenticates its access class", async () => {
    const access = "read";
    let membershipReads = 0;
    const app = new Elysia()
      .use(
        createAccountExportAuthMacro({
          authenticate: async () =>
            Result.ok({
              ...oauthSession,
              scopes: [ACCOUNT_EXPORT_SCOPES[access]],
            }),
          resolveAuthorization: async (identity) => {
            membershipReads += 1;
            expect<string>(identity.userId).toBe(oauthSession.userId);
            expect<string>(identity.organizationId).toBe(
              oauthSession.organizationId,
            );
            return memberAuthorization;
          },
          getSession: async () =>
            panic("Bearer requests must not read browser cookies"),
        }),
      )
      .get("/export", ({ user }) => user, {
        validateAccountExport: "read",
        accountAccess: ACCOUNT_ACCESS.accountControl,
      })
      .post("/export", ({ user }) => user, {
        validateAccountExport: "write",
        accountAccess: ACCOUNT_ACCESS.accountControl,
      });
    const headers = {
      authorization: "Bearer oauth-token",
      cookie: "another-session=present",
    };
    const read = await app.handle(
      new Request("http://localhost/export", { headers }),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      id: "user_one",
      email: "user@example.test",
    });
    const write = await app.handle(
      new Request("http://localhost/export", { headers, method: "POST" }),
    );
    expect(write.status).toBe(403);
    expect(membershipReads).toBe(1);
  });

  test("refuses a malformed credential", async () => {
    const authorization = "Bearer";
    const app = new Elysia()
      .use(
        createAccountExportAuthMacro({
          authenticate: async () =>
            panic("Malformed credentials must not reach verification"),
          getSession: async () =>
            panic("Invalid credentials must not fall back to cookies"),
        }),
      )
      .get("/export", () => "authenticated", {
        validateAccountExport: "read",
      });
    const response = await app.handle(
      new Request("http://localhost/export", {
        headers: { authorization, cookie: "session=present" },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("a verifier refusal remains final with cookies present", async () => {
    const app = new Elysia()
      .use(
        createAccountExportAuthMacro({
          authenticate: async () =>
            Result.err(
              new McpAuthenticationError({ message: "Invalid token" }),
            ),
          getSession: async () =>
            panic("Refused credentials must not fall back to cookies"),
        }),
      )
      .get("/export", () => "authenticated", { validateAccountExport: "read" });
    const response = await app.handle(
      new Request("http://localhost/export", {
        headers: {
          authorization: "Bearer invalid-token",
          cookie: "session=present",
        },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("verification outages are captured and remain retryable without cookie fallback", async () => {
    const app = new Elysia()
      .use(
        createAccountExportAuthMacro({
          authenticate: async () =>
            Result.err(
              new McpTokenVerificationError({
                message: "Verifier unavailable",
              }),
            ),
          getSession: async () =>
            panic("Verification outages must not fall back to cookies"),
        }),
      )
      .get("/export", () => "authenticated", { validateAccountExport: "read" });
    const response = await app.handle(
      new Request("http://localhost/export", {
        headers: {
          authorization: "Bearer oauth-token",
          cookie: "session=present",
        },
      }),
    );
    expect(response.status).toBe(500);
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("refuses a token without live membership", async () => {
    const app = new Elysia()
      .use(
        createAccountExportAuthMacro({
          authenticate: async () => Result.ok(oauthSession),
          resolveAuthorization: async () => null,
          getSession: async () =>
            panic("Bearer requests must not read cookies"),
        }),
      )
      .get("/export", () => "authenticated", { validateAccountExport: "read" });
    const response = await app.handle(
      new Request("http://localhost/export", {
        headers: { authorization: "Bearer oauth-token" },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("cookie authentication is selected only without authorization", async () => {
    let cookieReads = 0;
    const app = new Elysia()
      .use(
        createAccountExportAuthMacro({
          authenticate: async () =>
            panic("Cookie requests must not verify OAuth tokens"),
          getSession: async () => {
            cookieReads += 1;
            return { headers: new Headers(), response: null };
          },
        }),
      )
      .get("/export", () => "authenticated", { validateAccountExport: "read" });
    const response = await app.handle(
      new Request("http://localhost/export", {
        headers: { cookie: "session=invalid" },
      }),
    );
    expect(response.status).toBe(401);
    expect(cookieReads).toBe(1);
  });
});

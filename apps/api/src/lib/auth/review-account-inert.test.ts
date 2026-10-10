import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization, twoFactor } from "better-auth/plugins";
import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { authCapabilitiesRoute } from "@/api/handlers/auth/routes";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { resolveEmailAndPasswordOptions } from "@/api/lib/auth/password-sign-in-options";
import { checkRestrictedAccountOperation } from "@/api/lib/auth/review-account";
import { createReviewAccountPlugin } from "@/api/lib/auth/review-account-plugin";
import { narrowReviewOrganizationScopes } from "@/api/lib/auth/review-account-policy";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";

const email = "member@example.test";
const password = "fixture password for tests";
const unconfigured = { email: undefined, organizationId: undefined };

const previous = {
  email: env.APP_REVIEW_ACCOUNT_EMAIL,
  organizationId: env.APP_REVIEW_ORGANIZATION_ID,
  demoEmail: env.DEMO_ACCOUNT_EMAIL,
};

beforeAll(() => {
  env.APP_REVIEW_ACCOUNT_EMAIL = undefined;
  env.APP_REVIEW_ORGANIZATION_ID = undefined;
  env.DEMO_ACCOUNT_EMAIL = undefined;
});

afterAll(() => {
  env.APP_REVIEW_ACCOUNT_EMAIL = previous.email;
  env.APP_REVIEW_ORGANIZATION_ID = previous.organizationId;
  env.DEMO_ACCOUNT_EMAIL = previous.demoEmail;
});

/** The same auth setup with and without the review-account plugin. */
const createAuth = async ({
  withPlugin,
  localPasswordEnabled,
}: {
  withPlugin: boolean;
  localPasswordEnabled: boolean;
}) => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
      organization: [],
      member: [],
      invitation: [],
      team: [],
      teamMember: [],
      organizationRole: [],
    }),
    emailAndPassword: resolveEmailAndPasswordOptions({
      localPasswordEnabled,
      reviewAccountConfigured: false,
    }),
    session: {
      additionalFields: {
        activeOrganizationId: { type: "string", required: false },
      },
    },
    plugins: [
      ...(withPlugin
        ? [
            createReviewAccountPlugin({
              config: unconfigured,
              localPasswordEnabled,
            }),
          ]
        : []),
      twoFactor({ allowPasswordless: true }),
      organization({ allowUserToCreateOrganization: true }),
    ],
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { email, name: "Member", emailVerified: true },
    { method: "admin" },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await context.password.hash(password),
  });
  return auth;
};

const post = async (
  auth: { handler: (request: Request) => Promise<Response> },
  path: string,
  body: Record<string, unknown>,
  cookie?: string,
) =>
  await auth.handler(
    new Request(`http://localhost:3001/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
  );

/** Statuses of an ordinary account's sign-in and account operations. */
const runScenario = async (localPasswordEnabled: boolean) => {
  const statuses: Record<string, number> = {};
  for (const withPlugin of [false, true]) {
    const auth = await createAuth({ withPlugin, localPasswordEnabled });
    const signIn = await post(auth, "/sign-in/email", { email, password });
    const unknown = await post(auth, "/sign-in/email", {
      email: "unknown@example.test",
      password,
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; ");
    const steps: [string, Record<string, unknown>][] = [
      ["/organization/create", { name: "First", slug: "first" }],
      ["/organization/create", { name: "Second", slug: "second" }],
      ["/organization/set-active", { organizationSlug: "second" }],
      [
        "/organization/invite-member",
        { email: "guest@example.test", role: "member" },
      ],
      ["/unlink-account", { providerId: "credential" }],
      ["/two-factor/enable", {}],
    ];
    const results = [`sign-in:${signIn.status}`, `unknown:${unknown.status}`];
    if (signIn.ok) {
      for (const [path, body] of steps) {
        results.push(
          `${path}:${(await post(auth, path, body, cookie)).status}`,
        );
      }
    }
    statuses[withPlugin ? "with" : "without"] = results.length;
    statuses[`${withPlugin ? "with" : "without"}:${results.join(",")}`] = 1;
  }
  return statuses;
};

describe("restricted review account, unconfigured", () => {
  test("capabilities offer no restricted password sign-in", async () => {
    const response = await authCapabilitiesRoute.handle(
      new Request("http://localhost/auth/capabilities"),
    );
    const body = v.parse(
      v.object({ reviewPasswordSignIn: v.boolean() }),
      await response.json(),
    );
    expect(body.reviewPasswordSignIn).toBe(false);
    expect(
      resolveEmailAndPasswordOptions({
        localPasswordEnabled: false,
        reviewAccountConfigured: false,
      }),
    ).toBeUndefined();
  });

  test.each([false, true])(
    "sign-in and account operations match an auth without the plugin (local password %p)",
    async (localPasswordEnabled) => {
      const statuses = await runScenario(localPasswordEnabled);
      const outcome = (side: "with" | "without") =>
        Object.keys(statuses).find((key) => key.startsWith(`${side}:`));
      expect(outcome("with")?.slice("with:".length)).toBe(
        outcome("without")?.slice("without:".length),
      );
      if (localPasswordEnabled) {
        // Password sign-in works and the account operations ran.
        expect(outcome("with")).toContain("sign-in:200");
        expect(statuses["with"]).toBe(8);
      } else {
        expect(outcome("with")).not.toContain("sign-in:200");
      }
    },
  );

  test("MCP scopes and account-control operations are untouched", async () => {
    const scopes = [...MCP_OAUTH_SCOPES];
    expect(
      narrowReviewOrganizationScopes(
        { organizationId: "org_any", scopes },
        unconfigured,
      ).scopes,
    ).toEqual(scopes);
    const authenticated = await authenticateMcpRequest("credential.fixture", {
      verifyToken: async () => ({
        sub: "user_one",
        org_id: "org_any",
        scope: scopes.join(" "),
      }),
    });
    expect(Result.isOk(authenticated) && authenticated.value.scopes).toEqual(
      scopes,
    );
    for (const accountAccess of Object.values(ACCOUNT_ACCESS)) {
      expect(
        Result.isOk(checkRestrictedAccountOperation(email, accountAccess)),
      ).toBe(true);
    }
  });
});

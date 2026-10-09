import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import { REVIEW_ACCOUNT_EXCLUDED_SCOPES } from "@/api/lib/auth/review-account-policy";
import { toSafeId } from "@/api/lib/branded-types";
import { MACHINE_API_KEY_PREFIX } from "@/api/lib/machine-api-key-config";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { MCP_MODES, MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { McpOrganizationAccessError } from "@/api/mcp/errors";
import { NO_FEATURE_ACCESS_FACTS } from "@/api/tests/helpers/member-authorization";

const credentialCases = [
  { type: "oauth_client", claims: { client_id: "client_one" } },
  { type: "delegated_user", claims: {} },
  {
    type: "agent_run",
    claims: {
      purpose: "agent-run",
      run_id: "run_one",
      workspace_ids: ["workspace_one"],
    },
  },
  { type: "machine_api_key", claims: {} },
] as const;

describe("MCP account authorization", () => {
  test("authenticates every credential before refusing a restricted resolved identity", async () => {
    for (const credentialCase of credentialCases) {
      for (const mode of MCP_MODES) {
        for (const organizationId of ["org_one", "org_two"]) {
          const authenticated = await authenticateMcpRequest(
            credentialCase.type === "machine_api_key"
              ? `${MACHINE_API_KEY_PREFIX}fixture`
              : "credential.fixture",
            {
              mode,
              verifyToken: async () => ({
                sub: "user_one",
                org_id: organizationId,
                scope: "stella:read",
                ...credentialCase.claims,
              }),
              resolveApiKeySession: async () => ({
                userId: "user_one",
                organizationId,
                scopes: ["stella:read"],
                credential: {
                  type: "machine_api_key",
                  id: "key_one",
                  name: "fixture",
                  permissions: { workspace: ["read"] },
                },
              }),
            },
          );
          expect(Result.isOk(authenticated)).toBe(true);
          if (Result.isError(authenticated)) {
            continue;
          }
          expect(authenticated.value.credential?.type).toBe(
            credentialCase.type,
          );
          for (const binding of [undefined, "org_one"]) {
            let membershipReads = 0;
            let accountChecks = 0;
            const context = resolveMcpSessionContext(authenticated.value, {
              request: new Request("https://example.test/mcp"),
              resolveAuthorization: async (identity) => {
                membershipReads += 1;
                expect(identity.userId).toBe(toSafeId<"user">("user_one"));
                expect(identity.organizationId).toBe(
                  toSafeId<"organization">(organizationId),
                );
                return {
                  memberId: "member_one",
                  email: "limited@example.test",
                  role: "owner",
                  workspace: null,
                  ...NO_FEATURE_ACCESS_FACTS,
                };
              },
              checkAccountOperation: (email) => {
                accountChecks += 1;
                expect(email).toBe("limited@example.test");
                return checkDemoAccountAccess({
                  email,
                  config: {
                    email: "limited@example.test",
                    organizationId: binding,
                  },
                  operation: "growth",
                });
              },
            });
            const refused = await Result.tryPromise({
              try: async () => await context,
              catch: (cause) => cause,
            });
            expect(Result.isError(refused)).toBe(true);
            if (Result.isError(refused)) {
              expect(refused.error).toBeInstanceOf(McpOrganizationAccessError);
            }
            expect(membershipReads).toBe(1);
            expect(accountChecks).toBe(1);
          }
        }
      }
    }
  });

  test("continues ordinary account authorization after checking the resolved email", async () => {
    let accountChecks = 0;
    const context = resolveMcpSessionContext(
      {
        userId: "user_one",
        organizationId: "org_one",
        scopes: [],
        memberId: "previous_member",
      },
      {
        request: new Request("https://example.test/mcp"),
        resolveAuthorization: async () => ({
          memberId: "member_one",
          email: "standard@example.test",
          role: "owner",
          workspace: null,
          ...NO_FEATURE_ACCESS_FACTS,
        }),
        checkAccountOperation: (email) => {
          accountChecks += 1;
          return checkDemoAccountAccess({
            email,
            config: {
              email: "limited@example.test",
              organizationId: "org_one",
            },
            operation: "growth",
          });
        },
      },
    );
    const refused = await Result.tryPromise({
      try: async () => await context,
      catch: (cause) => cause,
    });
    expect(refused).toMatchObject({
      status: "error",
      error: { message: "Token was issued for a previous membership" },
    });
    expect(accountChecks).toBe(1);
  });

  test("refuses the review account in any organization but its own, whatever the credential", async () => {
    const previous = {
      reviewEmail: env.APP_REVIEW_ACCOUNT_EMAIL,
      reviewOrganization: env.APP_REVIEW_ORGANIZATION_ID,
    };
    env.APP_REVIEW_ACCOUNT_EMAIL = "review@example.test";
    env.APP_REVIEW_ORGANIZATION_ID = "org_review";
    try {
      for (const credentialCase of credentialCases) {
        const outcomes: Record<string, string> = {};
        for (const organizationId of ["org_review", "org_other"]) {
          // A grant issued for another organization while the account was a
          // member there: the token and the membership both still resolve.
          const authenticated = await authenticateMcpRequest(
            credentialCase.type === "machine_api_key"
              ? `${MACHINE_API_KEY_PREFIX}fixture`
              : "credential.fixture",
            {
              verifyToken: async () => ({
                sub: "user_review",
                org_id: organizationId,
                scope: "stella:read",
                ...credentialCase.claims,
              }),
              resolveApiKeySession: async () => ({
                userId: "user_review",
                organizationId,
                scopes: ["stella:read"],
                credential: {
                  type: "machine_api_key",
                  id: "key_one",
                  name: "fixture",
                  permissions: { workspace: ["read"] },
                },
              }),
            },
          );
          expect(Result.isOk(authenticated)).toBe(true);
          if (Result.isError(authenticated)) {
            continue;
          }
          const resolved = await Result.tryPromise({
            try: async () =>
              await resolveMcpSessionContext(
                { ...authenticated.value, memberId: "previous_member" },
                {
                  request: new Request("https://example.test/mcp"),
                  resolveAuthorization: async () => ({
                    memberId: "member_one",
                    email: "Review@Example.Test",
                    role: "owner",
                    workspace: null,
                    ...NO_FEATURE_ACCESS_FACTS,
                  }),
                },
              ),
            catch: (cause) => cause,
          });
          outcomes[organizationId] =
            Result.isError(resolved) && resolved.error instanceof Error
              ? resolved.error.message
              : "resolved";
        }
        expect(outcomes).toEqual({
          // Past the account checks, stopped by the stale membership fixture.
          org_review: "Token was issued for a previous membership",
          org_other: "This operation is unavailable for this account.",
        });
      }
    } finally {
      env.APP_REVIEW_ACCOUNT_EMAIL = previous.reviewEmail;
      env.APP_REVIEW_ORGANIZATION_ID = previous.reviewOrganization;
    }
  });

  test("opens MCP for the restricted review account and still refuses the demo account", async () => {
    const previous = {
      demoEmail: env.DEMO_ACCOUNT_EMAIL,
      demoOrganization: env.DEMO_ACCOUNT_ORGANIZATION_ID,
      reviewEmail: env.APP_REVIEW_ACCOUNT_EMAIL,
      reviewOrganization: env.APP_REVIEW_ORGANIZATION_ID,
    };
    env.DEMO_ACCOUNT_EMAIL = "limited@example.test";
    env.DEMO_ACCOUNT_ORGANIZATION_ID = "org_limited";
    env.APP_REVIEW_ACCOUNT_EMAIL = "review@example.test";
    env.APP_REVIEW_ORGANIZATION_ID = "org_review";
    try {
      const outcomes = new Map<string, unknown>();
      for (const email of ["review@example.test", "limited@example.test"]) {
        const resolved = await Result.tryPromise({
          try: async () =>
            await resolveMcpSessionContext(
              {
                userId: "user_one",
                organizationId: "org_review",
                scopes: [],
                // A stale membership stops resolution right after the
                // account check, without a database.
                memberId: "previous_member",
              },
              {
                request: new Request("https://example.test/mcp"),
                resolveAuthorization: async () => ({
                  memberId: "member_one",
                  email,
                  role: "owner",
                  workspace: null,
                  ...NO_FEATURE_ACCESS_FACTS,
                }),
              },
            ),
          catch: (cause) => cause,
        });
        outcomes.set(
          email,
          Result.isError(resolved) && resolved.error instanceof Error
            ? resolved.error.message
            : "resolved",
        );
      }
      expect(Object.fromEntries(outcomes)).toEqual({
        "review@example.test": "Token was issued for a previous membership",
        "limited@example.test":
          "This operation is unavailable for this account.",
      });
    } finally {
      env.DEMO_ACCOUNT_EMAIL = previous.demoEmail;
      env.DEMO_ACCOUNT_ORGANIZATION_ID = previous.demoOrganization;
      env.APP_REVIEW_ACCOUNT_EMAIL = previous.reviewEmail;
      env.APP_REVIEW_ORGANIZATION_ID = previous.reviewOrganization;
    }
  });

  test("withholds administrative, billing and external-server scopes from the review organization", async () => {
    const allScopes = [...MCP_OAUTH_SCOPES];
    for (const credentialCase of credentialCases) {
      for (const organizationId of ["org_review", "org_other"]) {
        const authenticated = await authenticateMcpRequest(
          credentialCase.type === "machine_api_key"
            ? `${MACHINE_API_KEY_PREFIX}fixture`
            : "credential.fixture",
          {
            reviewAccount: { organizationId: "org_review" },
            verifyToken: async () => ({
              sub: "user_one",
              org_id: organizationId,
              scope: allScopes.join(" "),
              ...credentialCase.claims,
            }),
            resolveApiKeySession: async () => ({
              userId: "user_one",
              organizationId,
              scopes: allScopes,
              credential: {
                type: "machine_api_key",
                id: "key_one",
                name: "fixture",
                permissions: { workspace: ["read"] },
              },
            }),
          },
        );
        expect(Result.isOk(authenticated)).toBe(true);
        if (Result.isError(authenticated)) {
          continue;
        }
        expect(authenticated.value.scopes).toEqual(
          organizationId === "org_review"
            ? allScopes.filter(
                (scope) =>
                  !(
                    REVIEW_ACCOUNT_EXCLUDED_SCOPES as readonly string[]
                  ).includes(scope),
              )
            : allScopes,
        );
      }
    }
    expect(REVIEW_ACCOUNT_EXCLUDED_SCOPES).toEqual([
      "stella:admin_read",
      "stella:admin_write",
      "stella:billing_write",
      "stella:external_mcps",
    ]);
  });
});

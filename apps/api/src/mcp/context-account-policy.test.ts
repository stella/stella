import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import { toSafeId } from "@/api/lib/branded-types";
import { MACHINE_API_KEY_PREFIX } from "@/api/lib/machine-api-key-config";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { MCP_MODES } from "@/api/mcp/constants";
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
});

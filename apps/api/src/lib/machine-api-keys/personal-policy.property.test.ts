import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";
import { roles, statements } from "@stll/permissions";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  API_KEY_KIND,
  PERSONAL_API_KEY_SCOPES,
  machineApiKeyMetadataSchema,
  machineApiKeyPermissionsSchema,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import type {
  PersonalApiKeyScope,
  PERSONAL_API_KEY_DEFAULT_SCOPES,
} from "@/api/lib/machine-api-key-config";
import {
  personalApiKeyPermissions,
  personalApiKeyPermissionsAllowed,
} from "@/api/lib/machine-api-keys/personal-policy";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { resolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import { mcpMemberAuthority } from "@/api/mcp/effective-authority";
import { McpAuthenticationError } from "@/api/mcp/errors";
import { NO_FEATURE_ACCESS_FACTS } from "@/api/tests/helpers/member-authorization";

const roleNames = Object.keys(roles).filter(isMemberRole);
const roleArbitrary = fc.constantFrom(...roleNames);
const createdAt = new Date();
const expiresAt = new Date(createdAt.getTime() + 30 * 86_400_000);
const capabilityCatalog = v.parse(
  v.array(
    v.object({
      id: v.string(),
      scope: v.string(),
      permissions: v.optional(v.nullable(machineApiKeyPermissionsSchema)),
    }),
  ),
  readCapabilityCatalog(),
);
const positiveWriteCapabilities = {
  "stella:documents_write": "entities.blank-document.create",
  "stella:matters_write": "matters.create",
  "stella:contacts_write": "contacts.create",
  "stella:knowledge_write": "clauses.create",
} as const satisfies Record<
  Exclude<
    PersonalApiKeyScope,
    (typeof PERSONAL_API_KEY_DEFAULT_SCOPES)[number]
  >,
  string
>;
const verifiedKey = (permissions: Record<string, string[]>) => ({
  id: "personal-fixture",
  configId: "machine",
  name: "Personal key",
  start: "stella_mk_fixture",
  prefix: "stella_mk_",
  key: "fixture-digest",
  referenceId: "user_fixture",
  enabled: true,
  metadata: {
    kind: API_KEY_KIND.personal,
    organizationId: "org_fixture",
    audience: "default",
    scopes: ["stella:search", "stella:read"],
  },
  permissions,
  createdAt,
  updatedAt: createdAt,
  expiresAt,
  lastRequest: null,
  refillInterval: null,
  refillAmount: null,
  lastRefillAt: null,
  remaining: null,
  rateLimitEnabled: true,
  rateLimitTimeWindow: 60_000,
  rateLimitMax: 600,
  requestCount: 0,
});

const verification = (permissions: Record<string, string[]>) => ({
  valid: true,
  error: null,
  key: verifiedKey(permissions),
});
const authorizeAs = (role: (typeof roleNames)[number]) => async () => ({
  memberId: "member_fixture",
  email: "member@example.test",
  role,
  workspace: null,
  ...NO_FEATURE_ACCESS_FACTS,
});

describe("personal API key authority", () => {
  test.each(
    PERSONAL_API_KEY_SCOPES.filter(
      (scope): scope is keyof typeof positiveWriteCapabilities =>
        Object.hasOwn(positiveWriteCapabilities, scope),
    ),
  )("explicit scope %s retains positive write authority", async (scope) => {
    const permissions = personalApiKeyPermissions(sessionMemberRole("member"), [
      scope,
    ]);
    const parsed = parseMachineApiKeyPermissions(permissions);
    expect(parsed.type).toBe("valid");
    if (parsed.type !== "valid") {
      return;
    }
    expect(
      Object.values(permissions)
        .flat()
        .some((action) => action !== "read"),
    ).toBe(true);
    const capabilityId = positiveWriteCapabilities[scope];
    const capability = capabilityCatalog.find(
      (entry) => entry.id === capabilityId,
    );
    expect(capability?.scope).toBe(scope);
    if (!capability?.permissions) {
      panic(
        "Each positive scope fixture must name actual capability permissions",
      );
    }
    const required = parseMachineApiKeyPermissions(capability.permissions);
    expect(required.type).toBe("valid");
    if (required.type !== "valid") {
      return;
    }
    expect(
      hasMemberPermission(
        mcpMemberAuthority({
          memberRole: "member",
          credentialPermissions: parsed.permissions,
        }),
        required.permissions,
      ),
    ).toBe(true);
    const permittedResources = new Set(
      capabilityCatalog
        .filter((entry) => entry.scope === scope)
        .flatMap((entry) => Object.keys(entry.permissions ?? {})),
    );
    for (const [resource, actions] of Object.entries(permissions)) {
      if (
        resource === "workspace" &&
        actions.every((action) => action === "read")
      ) {
        continue;
      }
      expect(permittedResources.has(resource)).toBe(true);
    }
    const session = await resolveMachineApiKeySession("stella_mk_fixture", {
      verifyApiKey: async () => {
        const verified = verification(permissions);
        verified.key.metadata.scopes = [scope];
        return verified;
      },
      resolveAuthorization: authorizeAs("member"),
      resolvePersonalPolicy: async () => "enabled",
    });
    expect(session.credential?.type).toBe("personal_api_key");
    if (session.credential?.type !== "personal_api_key") {
      return;
    }
    expect(session.credential.permissions).toEqual(parsed.permissions);
    expect(
      hasMemberPermission(
        mcpMemberAuthority({
          memberRole: "member",
          credentialPermissions: session.credential.permissions,
        }),
        parsed.permissions,
      ),
    ).toBe(true);
  });
  test(
    "personal keys never exceed the owner's current role",
    async () => {
      await assertProperty(
        "personal keys never exceed the owner's current role",
        fc.asyncProperty(
          roleArbitrary,
          roleArbitrary,
          fc.shuffledSubarray([...PERSONAL_API_KEY_SCOPES], { minLength: 1 }),
          async (originalRole, currentRole, scopes) => {
            const permissions = personalApiKeyPermissions(
              sessionMemberRole(originalRole),
              scopes,
            );
            const parsed = parseMachineApiKeyPermissions(permissions);
            expect(parsed.type).toBe("valid");
            if (parsed.type !== "valid") {
              return;
            }
            const outcome = await Result.tryPromise(
              async () =>
                await resolveMachineApiKeySession("stella_mk_fixture", {
                  verifyApiKey: async () => {
                    const verified = verification(permissions);
                    verified.key.metadata.scopes = scopes;
                    return verified;
                  },
                  resolveAuthorization: authorizeAs(currentRole),
                  resolvePersonalPolicy: async () => "enabled",
                }),
            );
            expect(outcome.isOk()).toBe(
              hasMemberPermission(
                sessionMemberRole(currentRole),
                parsed.permissions,
              ),
            );
            if (outcome.isErr()) {
              expect(outcome.error.cause).toBeInstanceOf(
                McpAuthenticationError,
              );
              return;
            }
            const credential = outcome.value.credential;
            expect(credential?.type).toBe("personal_api_key");
            if (credential?.type !== "personal_api_key") {
              return;
            }
            expect(credential.permissions).toEqual(parsed.permissions);
            expect(outcome.value.scopes).toEqual(scopes);
            const authority = mcpMemberAuthority({
              memberRole: currentRole,
              credentialPermissions: credential.permissions,
            });
            for (const [resource, actions] of Object.entries(statements)) {
              for (const action of actions) {
                const single = parseMachineApiKeyPermissions({
                  [resource]: [action],
                });
                expect(single.type).toBe("valid");
                if (single.type !== "valid") {
                  continue;
                }
                if (hasMemberPermission(authority, single.permissions)) {
                  expect(
                    hasMemberPermission(
                      sessionMemberRole(currentRole),
                      single.permissions,
                    ),
                  ).toBe(true);
                  expect(
                    hasMemberPermission(
                      sessionMemberRole(originalRole),
                      single.permissions,
                    ),
                  ).toBe(true);
                }
              }
            }
            expect(personalApiKeyPermissionsAllowed(permissions, scopes)).toBe(
              true,
            );
          },
        ),
      );
    },
    propertyTestTimeout(15_000),
  );

  test("read-only defaults carry no write permissions for any role", () => {
    for (const role of roleNames) {
      expect(personalApiKeyPermissions(sessionMemberRole(role))).toEqual({
        workspace: ["read"],
        searchHistory: ["read"],
      });
    }
  });

  test("own history authority follows read and knowledge-write consent for every role", () => {
    for (const role of roleNames) {
      const memberRole = sessionMemberRole(role);
      for (const scope of PERSONAL_API_KEY_SCOPES) {
        const permissions = personalApiKeyPermissions(memberRole, [scope]);
        switch (scope) {
          case "stella:read":
            expect(permissions["searchHistory"]).toEqual(["read"]);
            break;
          case "stella:knowledge_write":
            expect(permissions["searchHistory"]).toEqual(["delete"]);
            break;
          case "stella:contacts_write":
          case "stella:documents_write":
          case "stella:matters_write":
          case "stella:search":
            expect(permissions["searchHistory"]).toBeUndefined();
            break;
          default:
            scope satisfies never;
        }
        expect(
          personalApiKeyPermissionsAllowed({ searchHistory: ["create"] }, [
            scope,
          ]),
        ).toBe(false);
      }
      expect(
        personalApiKeyPermissions(memberRole, [
          "stella:read",
          "stella:knowledge_write",
        ])["searchHistory"],
      ).toEqual(["read", "delete"]);
    }
  });

  test("removing the owner refuses the key", async () => {
    const outcome = await Result.tryPromise(async () =>
      resolveMachineApiKeySession("stella_mk_fixture", {
        verifyApiKey: async () => verification({ workspace: ["read"] }),
        resolveAuthorization: async () => null,
        resolvePersonalPolicy: async () => "enabled",
      }),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.cause).toBeInstanceOf(McpAuthenticationError);
    }
  });

  test("a disabled organization policy kills an otherwise valid key", async () => {
    const outcome = await Result.tryPromise(async () =>
      resolveMachineApiKeySession("stella_mk_fixture", {
        verifyApiKey: async () => verification({ workspace: ["read"] }),
        resolveAuthorization: authorizeAs("member"),
        resolvePersonalPolicy: async () => "disabled",
      }),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.cause).toBeInstanceOf(McpAuthenticationError);
    }
  });

  test("a personal key is bound to exactly one audience", async () => {
    for (const mode of ["law", "documents", "anonymized"] as const) {
      const outcome = await Result.tryPromise(
        async () =>
          await resolveMachineApiKeySession("stella_mk_fixture", {
            mode,
            verifyApiKey: async () => verification({ workspace: ["read"] }),
            resolveAuthorization: authorizeAs("owner"),
            resolvePersonalPolicy: async () => "enabled",
          }),
      );
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error.cause).toBeInstanceOf(McpAuthenticationError);
      }
    }
  });

  test.each([
    "stella:admin_read",
    "stella:admin_write",
    "stella:billing_write",
    "stella:onboarding",
  ])("personal metadata rejects %s before authorization", (scope) => {
    const key = verifiedKey({ workspace: ["read"] });
    expect(
      v.safeParse(machineApiKeyMetadataSchema, {
        ...key.metadata,
        scopes: [scope],
      }).success,
    ).toBe(false);
  });

  test("personal credentials cannot carry administrative permissions", async () => {
    const outcome = await Result.tryPromise(async () =>
      resolveMachineApiKeySession("stella_mk_fixture", {
        verifyApiKey: async () =>
          verification({ organizationSettings: ["update"] }),
        resolveAuthorization: authorizeAs("owner"),
        resolvePersonalPolicy: async () => "enabled",
      }),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.cause).toBeInstanceOf(McpAuthenticationError);
    }
  });
});

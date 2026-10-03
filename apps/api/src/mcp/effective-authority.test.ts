import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  credentialPermissionsForContext,
  readAuthorizedMemberRole,
  roleForDisplay,
} from "@/api/lib/permission-authorization";
import { synthesizeCapabilityContext } from "@/api/mcp/capability-context";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  hasEffectiveAuthority,
  mcpMemberAuthority,
} from "@/api/mcp/effective-authority";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Authority state is private, so equality is checked on what it exposes.
const shape = (authority: AuthorizedMemberRole) => ({
  role: roleForDisplay(authority),
  credentialPermissions: credentialPermissionsForContext(authority),
});

describe("MCP member authority", () => {
  test("a credential with its own set becomes an attenuated authority", () => {
    expect(
      shape(
        mcpMemberAuthority({
          memberRole: "owner",
          credentialPermissions: { view: ["create"] },
        }),
      ),
    ).toEqual({ role: "owner", credentialPermissions: { view: ["create"] } });
    expect(shape(mcpMemberAuthority({ memberRole: "admin" }))).toEqual({
      role: "admin",
      credentialPermissions: undefined,
    });
  });

  test("the MCP check and the handler check agree", () => {
    const narrowed = {
      memberRole: "owner" as const,
      credentialPermissions: { timeEntry: ["read" as const] },
    };
    expect(hasEffectiveAuthority(narrowed, { timeEntry: ["read"] })).toBe(true);
    expect(hasEffectiveAuthority(narrowed, { timeEntry: ["approve"] })).toBe(
      false,
    );
    expect(
      hasEffectiveAuthority(
        { memberRole: "owner" },
        { timeEntry: ["approve"] },
      ),
    ).toBe(true);
  });
});

describe("the context a capability handler receives", () => {
  const contextWith = (
    credentialPermissions: McpRequestContext["credentialPermissions"],
  ) =>
    asTestRaw<McpRequestContext>({
      testDependencies: {
        loadOrgSettingsForAuth: mock(async () => ({
          orgAIConfig: null,
          orgAIConfigStatus: "ok",
          promptCachingEnabled: false,
          managedAIResidency: "eu",
        })),
      },
      createOperationDatabaseScope: () => ({
        pinServerValidatedWorkspaceId: () => true,
        safeDb: async () => undefined,
        scopedDb: async () => undefined,
      }),
      credentialPermissions,
      memberRole: "owner",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      userEmail: "owner@example.test",
      accessibleWorkspaceIds: [],
      accessibleWorkspaces: [],
      accessibleWorkspaceStatusById: new Map(),
      recordAuditEvent: async () => undefined,
    });

  const synthesize = async (
    credentialPermissions: McpRequestContext["credentialPermissions"],
  ) =>
    await synthesizeCapabilityContext({
      capabilityId: "views.create",
      context: contextWith(credentialPermissions),
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost/mcp"),
      workspaceId: undefined,
    });

  // Every handler-level decision reads this field, so carrying the credential
  // here is what keeps a narrowed key narrow inside compound handlers.
  test("carries a narrowed credential's own set", async () => {
    const synthesized = await synthesize({ view: ["create"] });

    expect(shape(readAuthorizedMemberRole(synthesized))).toEqual({
      role: "owner",
      credentialPermissions: { view: ["create"] },
    });
  });

  test("carries a session credential when the credential has no set", async () => {
    const synthesized = await synthesize(undefined);

    expect(shape(readAuthorizedMemberRole(synthesized))).toEqual({
      role: "owner",
      credentialPermissions: undefined,
    });
  });
});

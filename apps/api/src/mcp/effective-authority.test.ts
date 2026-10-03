import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { readAuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { synthesizeCapabilityContext } from "@/api/mcp/capability-context";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  hasEffectiveAuthority,
  mcpMemberAuthority,
} from "@/api/mcp/effective-authority";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("MCP member authority", () => {
  test("a credential with its own set becomes an attenuated authority", () => {
    expect(
      mcpMemberAuthority({
        memberRole: "owner",
        credentialPermissions: { view: ["create"] },
      }),
    ).toEqual({
      role: "owner",
      credential: { type: "attenuated", permissions: { view: ["create"] } },
    });
    expect(mcpMemberAuthority({ memberRole: "admin" })).toEqual({
      role: "admin",
      credential: { type: "session" },
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

    expect(readAuthorizedMemberRole(synthesized)).toEqual({
      role: "owner",
      credential: { type: "attenuated", permissions: { view: ["create"] } },
    });
  });

  test("carries a session credential when the credential has no set", async () => {
    const synthesized = await synthesize(undefined);

    expect(readAuthorizedMemberRole(synthesized)).toEqual({
      role: "owner",
      credential: { type: "session" },
    });
  });
});

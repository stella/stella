import { panic } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { DEFAULT_MCP_CLI_ANNOTATIONS } from "@/api/mcp/static-cli-metadata";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { listMcpTools } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

// A DB accessor that fails the test if any handler reaches it. Every assertion
// here exercises authorization or input validation, which must reject before
// the tool touches the database.
const throwingScopedDb = asTestRaw<AuthorizedMcpRequestContext["scopedDb"]>(
  () => {
    throw new Error("database must not be reached in a rejection path");
  },
);

const createContext = (
  memberRole: MemberRole = "owner",
): AuthorizedMcpRequestContext =>
  authorizedMcpContextForTest({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole,
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: async () => {},
    safeDb: toSafeDbMock(throwingScopedDb),
    scopedDb: throwingScopedDb,
    // The MCP transport holds a permit for every request (`context.ts`).
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (result: McpToolResponse): string => {
  if (isMcpEgressPlan(result)) {
    throw new Error("expected a CallToolResult, got an egress plan");
  }
  const serialized = serializeToolResult(result);
  expect(serialized.isError).toBe(true);
  const first = serialized.content[0];
  return first !== undefined && "text" in first ? first.text : "";
};

// The human message of a structured `{ error: { code, message, issues? } }`
// envelope. Used where a validation failure now carries the envelope instead of
// bare plain text; legacy plain-text errors fall through unchanged.
const errorMessage = (result: McpToolResponse): string => {
  const raw = errorText(result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (isRecord(parsed) && isRecord(parsed["error"])) {
    const message = parsed["error"]["message"];
    if (typeof message === "string") {
      return message;
    }
  }
  return raw;
};

describe("list_audit_log", () => {
  test("fails closed on the anonymized surface", () => {
    const def = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "list_audit_log",
    );
    // The dynamic tenant payload (free-form change diffs) cannot be enumerated
    // for field-level redaction, so the tool is excluded rather than partially
    // anonymized.
    expect(def?.anonymized).toEqual({
      exposure: "excluded",
      reason: "dynamic_tenant_payload",
    });
    expect(def?.scope).toBe("stella:admin_read");
    expect(
      ANONYMIZED_MCP_TOOL_DEFINITIONS.some(
        (tool) => tool.name === "list_audit_log",
      ),
    ).toBe(false);
  });

  test("forbids roles without organization audit-log access", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log({
      args: {},
      context: createContext("member"),
    });
    expect(errorText(result)).toBe("Forbidden");
  });

  test("replicates the backing resourceId-requires-resourceType rejection", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log({
      args: { resource_id: "matter_1" },
      context: createContext("owner"),
    });
    expect(errorMessage(result)).toBe(
      "resourceType is required when resourceId is provided",
    );
  });

  test("rejects permissive Date inputs that are not ISO timestamps", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log({
      args: { from: "August 23, 2026" },
      context: createContext("owner"),
    });

    expect(errorText(result)).toContain('"code":"validation_error"');
  });

  test("rejects a well-shaped bound that is not a real calendar date or time", async () => {
    for (const from of [
      "2026-02-31",
      "2026-13-01T00:00:00Z",
      "2026-09-05T29:99:00Z",
    ]) {
      const result = await RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log({
        args: { from },
        context: createContext("owner"),
      });
      expect(errorText(result)).toContain('"code":"validation_error"');
    }
  });
});

describe("search_boe_legislation feature gating", () => {
  const withPublicLaw = async (
    {
      featurePublicLaw,
      localDevOpen,
    }: { featurePublicLaw: boolean; localDevOpen: boolean },
    run: () => Promise<void>,
  ) => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    env.FEATURE_PUBLIC_LAW = featurePublicLaw;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: localDevOpen ? RUNTIME_MODE.open : RUNTIME_MODE.strict,
    });
    try {
      await run();
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      restoreRuntimeMode();
    }
  };

  test("carries the FEATURE_PUBLIC_LAW gate and passthrough policy", () => {
    const def = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "search_boe_legislation",
    );
    expect(def?.feature).toBe("FEATURE_PUBLIC_LAW");
    expect(def?.anonymized).toEqual({ exposure: "passthrough" });
  });

  test("is hidden when the flag is off outside dev", async () => {
    await withPublicLaw(
      { featurePublicLaw: false, localDevOpen: false },
      async () => {
        const names = (
          await listMcpTools(createContext(), "default", ["stella:read"])
        ).map((tool) => tool.name);
        expect(names).not.toContain("search_boe_legislation");
        // An untagged stella:read tool stays listed: only the gate drops.
        expect(names).toContain("list_matters");
      },
    );
  });

  test("is listed when the flag is on, and in dev regardless", async () => {
    await withPublicLaw(
      { featurePublicLaw: true, localDevOpen: false },
      async () => {
        const names = (
          await listMcpTools(createContext(), "default", ["stella:read"])
        ).map((tool) => tool.name);
        expect(names).toContain("search_boe_legislation");
      },
    );
    await withPublicLaw(
      { featurePublicLaw: false, localDevOpen: true },
      async () => {
        const names = (
          await listMcpTools(createContext(), "default", ["stella:read"])
        ).map((tool) => tool.name);
        expect(names).toContain("search_boe_legislation");
      },
    );
  });

  test("rejects block_id without law_id before any BOE fetch", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_boe_legislation({
      args: { block_id: "a1" },
      context: createContext("owner"),
    });
    expect(errorMessage(result)).toBe("block_id requires law_id");
  });

  test("refuses a context without a third-party outbound permit before any BOE fetch", async () => {
    const searchConsolidatedLegislation = mock(async () =>
      panic("The BOE must not be asked without a permit"),
    );
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_boe_legislation({
      args: { query: "arrendamiento" },
      context: {
        ...createContext("owner"),
        thirdPartyOutboundPermit: undefined,
        testDependencies: { searchConsolidatedLegislation },
      },
    });
    expect(errorText(result)).toContain('"code":"permission_denied"');
    expect(searchConsolidatedLegislation).not.toHaveBeenCalled();
  });

  test("requires at least one search filter in search mode", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_boe_legislation({
      args: {},
      context: createContext("owner"),
    });
    expect(errorMessage(result)).toBe(
      "Provide law_id to read a law, or at least one search filter",
    );
  });
});

describe("matter membership and organization settings", () => {
  test("each operation exposes only its own inputs and accurate annotations", () => {
    const expected = {
      add_matter_member: {
        title: "Add matter member",
        destructiveHint: false,
        idempotentHint: false,
      },
      remove_matter_member: {
        title: "Remove matter member",
        destructiveHint: true,
        idempotentHint: false,
      },
      update_organization_settings: {
        title: "Update organization settings",
        destructiveHint: false,
        idempotentHint: true,
      },
    } as const;
    for (const [name, annotations] of Object.entries(expected)) {
      const definition = DEFAULT_MCP_TOOL_DEFINITIONS.find(
        (tool) => tool.name === name,
      );
      expect(definition?.annotations).toEqual({
        ...annotations,
        readOnlyHint: false,
        openWorldHint: false,
      });
      expect(definition?.inputSchema.properties).not.toHaveProperty("action");
      expect(definition?.inputSchema["required"] ?? []).toEqual(
        name === "update_organization_settings" ? [] : ["matter_id", "user_id"],
      );
    }
    expect(DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).not.toContain(
      "manage_organization",
    );
    expect(DEFAULT_MCP_CLI_ANNOTATIONS.remove_matter_member.command).toEqual([
      "matter",
      "remove-member",
    ]);
  });

  test("member operations require a user and reject settings and discriminator inputs", async () => {
    for (const name of ["add_matter_member", "remove_matter_member"] as const) {
      const handler = RESEARCH_ADMIN_TOOL_HANDLERS[name];
      expect(
        errorText(
          await handler({
            args: { matter_id: WORKSPACE_ID },
            context: createContext(),
          }),
        ),
      ).toContain("user_id");
      for (const extra of [
        { prompt_caching_enabled: true },
        { action: "add_member" },
      ]) {
        expect(
          errorText(
            await handler({
              args: { matter_id: WORKSPACE_ID, user_id: "user_2", ...extra },
              context: createContext(),
            }),
          ),
        ).toContain("validation_error");
      }
    }
  });

  test("only member removal accepts a replacement", async () => {
    const args = {
      matter_id: WORKSPACE_ID,
      user_id: "user_2",
      reassign_to: "user_3",
    };
    expect(
      errorText(
        await RESEARCH_ADMIN_TOOL_HANDLERS.add_matter_member({
          args,
          context: createContext(),
        }),
      ),
    ).toContain("validation_error");
    expect(
      errorText(
        await RESEARCH_ADMIN_TOOL_HANDLERS.remove_matter_member({
          args,
          context: createContext(),
        }),
      ),
    ).toContain("Matter not found or not accessible");
  });

  test("settings reject empty updates, unpaired numbering, and member fields", async () => {
    const handler = RESEARCH_ADMIN_TOOL_HANDLERS.update_organization_settings;
    expect(
      errorMessage(await handler({ args: {}, context: createContext() })),
    ).toBe("Provide at least one setting to change");
    expect(
      errorMessage(
        await handler({
          args: { matter_number_pattern: "{YYYY}-{SEQ}" },
          context: createContext(),
        }),
      ),
    ).toBe(
      "matter_number_pattern and matter_number_padding must be sent together",
    );
    expect(
      errorText(
        await handler({
          args: { prompt_caching_enabled: true, matter_id: WORKSPACE_ID },
          context: createContext(),
        }),
      ),
    ).toContain("matter_id");
    const definition = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "update_organization_settings",
    );
    expect(
      definition?.inputSchema.properties?.["document_processing_mode"],
    ).toMatchObject({ type: "string", enum: ["off", "searchable-text"] });
    expect(
      errorText(
        await handler({
          args: { document_processing_mode: "structured-document" },
          context: createContext(),
        }),
      ),
    ).toContain("document_processing_mode");
  });
});

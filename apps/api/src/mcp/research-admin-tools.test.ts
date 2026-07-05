import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import type { McpRequestContext } from "@/api/mcp/context";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { listMcpTools } from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

// A DB accessor that fails the test if any handler reaches it. Every assertion
// here exercises authorization or input validation, which must reject before
// the tool touches the database.
const throwingScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(() => {
  throw new Error("database must not be reached in a rejection path");
});

const createContext = (
  memberRole: MemberRole = "owner",
): McpRequestContext => ({
  accessibleWorkspaceIds: [],
  accessibleWorkspaceIdSet: new Set(),
  accessibleWorkspaceStatusById: new Map(),
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: async () => {},
  safeDb: toSafeDbMock(throwingScopedDb),
  scopedDb: throwingScopedDb,
  userId: toSafeId<"user">("user_1"),
});

const errorText = (result: McpToolResponse): string => {
  if (isMcpEgressPlan(result)) {
    throw new Error("expected a CallToolResult, got an egress plan");
  }
  expect(result.isError).toBe(true);
  const first = result.content[0];
  return first !== undefined && "text" in first ? first.text : "";
};

describe("read_audit_log", () => {
  test("fails closed on the anonymized surface", () => {
    const def = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "read_audit_log",
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
        (tool) => tool.name === "read_audit_log",
      ),
    ).toBe(false);
  });

  test("forbids roles without organization audit-log access", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.read_audit_log({
      args: {},
      context: createContext("member"),
    });
    expect(errorText(result)).toBe("Forbidden");
  });

  test("replicates the backing resourceId-requires-resourceType rejection", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.read_audit_log({
      args: { resource_id: "matter_1" },
      context: createContext("owner"),
    });
    expect(errorText(result)).toBe(
      "resourceType is required when resourceId is provided",
    );
  });
});

describe("search_legislation feature gating", () => {
  const withPublicLaw = async (
    { featurePublicLaw, isDev }: { featurePublicLaw: boolean; isDev: boolean },
    run: () => Promise<void>,
  ) => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    const previousIsDev = env.isDev;
    env.FEATURE_PUBLIC_LAW = featurePublicLaw;
    env.isDev = isDev;
    try {
      await run();
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      env.isDev = previousIsDev;
    }
  };

  test("carries the FEATURE_PUBLIC_LAW gate and passthrough policy", () => {
    const def = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "search_legislation",
    );
    expect(def?.feature).toBe("FEATURE_PUBLIC_LAW");
    expect(def?.anonymized).toEqual({ exposure: "passthrough" });
  });

  test("is hidden when the flag is off outside dev", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      const names = (
        await listMcpTools(createContext(), "default", ["stella:read"])
      ).map((tool) => tool.name);
      expect(names).not.toContain("search_legislation");
      // An untagged stella:read tool stays listed: only the gate drops.
      expect(names).toContain("list_matters");
    });
  });

  test("is listed when the flag is on, and in dev regardless", async () => {
    await withPublicLaw({ featurePublicLaw: true, isDev: false }, async () => {
      const names = (
        await listMcpTools(createContext(), "default", ["stella:read"])
      ).map((tool) => tool.name);
      expect(names).toContain("search_legislation");
    });
    await withPublicLaw({ featurePublicLaw: false, isDev: true }, async () => {
      const names = (
        await listMcpTools(createContext(), "default", ["stella:read"])
      ).map((tool) => tool.name);
      expect(names).toContain("search_legislation");
    });
  });

  test("rejects block_id without law_id before any BOE fetch", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_legislation({
      args: { block_id: "a1" },
      context: createContext("owner"),
    });
    expect(errorText(result)).toBe("block_id requires law_id");
  });

  test("requires at least one search filter in search mode", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_legislation({
      args: {},
      context: createContext("owner"),
    });
    expect(errorText(result)).toBe(
      "Provide law_id to read a law, or at least one search filter",
    );
  });
});

describe("manage_organization per-action validation", () => {
  const run = async (args: Record<string, unknown>) =>
    await RESEARCH_ADMIN_TOOL_HANDLERS.manage_organization({
      args,
      context: createContext("owner"),
    });

  test("requires user_id for a member action", async () => {
    expect(
      errorText(await run({ action: "add_member", matter_id: "ws_1" })),
    ).toBe("user_id is required for add_member and remove_member");
  });

  test("rejects org-settings fields on a member action", async () => {
    const message = errorText(
      await run({
        action: "remove_member",
        matter_id: "ws_1",
        user_id: "user_2",
        prompt_caching_enabled: false,
      }),
    );
    expect(message).toBe(
      "matter_number_pattern, matter_number_padding, and prompt_caching_enabled apply only to update_org_settings",
    );
  });

  test("rejects an empty update_org_settings action", async () => {
    expect(errorText(await run({ action: "update_org_settings" }))).toBe(
      "Provide at least one setting to change for update_org_settings",
    );
  });

  test("requires the matter pattern and padding to be sent together", async () => {
    expect(
      errorText(
        await run({
          action: "update_org_settings",
          matter_number_pattern: "{YYYY}-{SEQ}",
        }),
      ),
    ).toBe(
      "matter_number_pattern and matter_number_padding must be sent together",
    );
  });

  test("rejects an unknown action shape", async () => {
    expect(errorText(await run({ action: "promote_admin" }))).toContain(
      "action",
    );
  });
});

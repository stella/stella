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
import type { McpToolDefinition, McpToolResponse } from "@/api/mcp/tool-types";
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
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: async () => {},
  safeDb: toSafeDbMock(throwingScopedDb),
  scopedDb: throwingScopedDb,
  userId: toSafeId<"user">("user_1"),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (result: McpToolResponse): string => {
  if (isMcpEgressPlan(result)) {
    throw new Error("expected a CallToolResult, got an egress plan");
  }
  expect(result.isError).toBe(true);
  const first = result.content[0];
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

const runManageOrg = async (args: Record<string, unknown>) =>
  await RESEARCH_ADMIN_TOOL_HANDLERS.manage_organization({
    args,
    context: createContext("owner"),
  });

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
    expect(errorMessage(result)).toBe("block_id requires law_id");
  });

  test("requires at least one search filter in search mode", async () => {
    const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_legislation({
      args: {},
      context: createContext("owner"),
    });
    expect(errorMessage(result)).toBe(
      "Provide law_id to read a law, or at least one search filter",
    );
  });
});

describe("manage_organization per-action validation", () => {
  test("requires user_id for a member action", async () => {
    expect(
      errorMessage(
        await runManageOrg({ action: "add_member", matter_id: "ws_1" }),
      ),
    ).toBe("user_id is required for add_member and remove_member");
  });

  test("rejects org-settings fields on a member action", async () => {
    const message = errorMessage(
      await runManageOrg({
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
    expect(
      errorMessage(await runManageOrg({ action: "update_org_settings" })),
    ).toBe("Provide at least one setting to change for update_org_settings");
  });

  test("requires the matter pattern and padding to be sent together", async () => {
    expect(
      errorMessage(
        await runManageOrg({
          action: "update_org_settings",
          matter_number_pattern: "{YYYY}-{SEQ}",
        }),
      ),
    ).toBe(
      "matter_number_pattern and matter_number_padding must be sent together",
    );
  });

  test("rejects an unknown action shape", async () => {
    expect(
      errorText(await runManageOrg({ action: "promote_admin" })),
    ).toContain("action");
  });
});

describe("manage_organization remove_member confirm gate", () => {
  test("the tool is not marked destructiveHint (so the central gate skips it)", () => {
    // Widen to the SDK annotations shape (the `as const` registry element types
    // annotations to only the keys manage_organization declares, which omits
    // destructiveHint) so the assertion below can read the hint it must be absent.
    const definitions: readonly McpToolDefinition[] =
      DEFAULT_MCP_TOOL_DEFINITIONS;
    const def = definitions.find((tool) => tool.name === "manage_organization");
    expect(def).toBeDefined();
    // manage_organization also adds members and updates settings, so it must not
    // trip the whole-tool central confirm gate: it carries no destructiveHint.
    // The remove_member gate is action-level inside the handler instead. (It
    // does carry the behavioural idempotent/open-world hints like every write
    // tool; only destructiveHint drives the central gate.)
    expect(def?.annotations?.destructiveHint).not.toBe(true);
  });

  test("remove_member without confirm is refused with confirmation_required", async () => {
    const payload = JSON.parse(
      errorText(
        await runManageOrg({
          action: "remove_member",
          matter_id: "ws_1",
          user_id: "user_2",
        }),
      ),
    );
    expect(payload.error.code).toBe("confirmation_required");
  });

  test("remove_member with confirm clears the gate and proceeds to resolution", async () => {
    // With confirm the action-level gate passes; the op then fails on workspace
    // access (this context grants none), proving it advanced past the gate
    // rather than being blocked by it.
    const text = errorText(
      await runManageOrg({
        action: "remove_member",
        matter_id: "ws_1",
        user_id: "user_2",
        confirm: true,
      }),
    );
    expect(text).not.toContain("confirmation_required");
    expect(text).toContain("Matter not found or not accessible");
  });

  test("update_org_settings is unaffected by the confirm gate", async () => {
    // A non-remove action needs no confirm; its own validation fires first.
    expect(
      errorMessage(await runManageOrg({ action: "update_org_settings" })),
    ).toBe("Provide at least one setting to change for update_org_settings");
  });
});

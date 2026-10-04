import { describe, expect, test } from "bun:test";

import { roles } from "@stll/permissions";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildChatWriteTools } from "@/api/handlers/chat/tools/registry-write-tools";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { isMemberRole, type MemberRole } from "@/api/lib/member-roles";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { MCP_MODES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { listOfferedStaticMcpToolDefinitions } from "@/api/mcp/gateway/static-tool-visibility";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { handleMcpToolCall } from "@/api/mcp/tools";
import {
  isMemberAuthorizedForMcpTool,
  type McpToolAuthorityDeclaration,
} from "@/api/mcp/write-tool-authority";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import ledger from "./write-tool-authority-ledger.json" with { type: "json" };

const MEMBER_ROLES: readonly MemberRole[] =
  Object.keys(roles).filter(isMemberRole);

/** Every static write tool on every MCP surface, once per name. */
const writeDefinitions = (): McpToolDefinition[] => {
  const byName = new Map<string, McpToolDefinition>();
  for (const mode of MCP_MODES) {
    for (const definition of listStaticMcpToolDefinitions(mode)) {
      if (definition.access === "write") {
        byName.set(definition.name, definition);
      }
    }
  }
  return [...byName.values()].toSorted((left, right) =>
    left.name < right.name ? -1 : 1,
  );
};

const mcpContextFor = (role: MemberRole): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    enabledRegistrySlugs: undefined,
    grantedScopes: [],
    memberRole: role,
  });

/**
 * The guard: every tool a role is offered must be one its declared
 * permissions authorize. `offered` is the surface under test, so the
 * self-test can hand it a surface whose gate is missing.
 */
const unauthorizedOffers = (
  definitions: readonly (McpToolAuthorityDeclaration & { name: string })[],
  offered: (role: MemberRole) => ReadonlySet<string>,
): string[] =>
  MEMBER_ROLES.flatMap((role) => {
    const names = offered(role);
    return definitions
      .filter(
        (definition) =>
          names.has(definition.name) &&
          !isMemberAuthorizedForMcpTool(sessionMemberRole(role), definition),
      )
      .map((definition) => `${role} is offered ${definition.name}`);
  });

const mcpOffered = (role: MemberRole): ReadonlySet<string> =>
  new Set(
    MCP_MODES.flatMap((mode) =>
      listOfferedStaticMcpToolDefinitions({
        context: mcpContextFor(role),
        mode,
      }).map((definition) => definition.name),
    ),
  );

const noopScopedDb = asTestRaw<ScopedDb>(
  async (run: (tx: unknown) => unknown) => await run({}),
);

const chatOffered = (role: MemberRole): ReadonlySet<string> =>
  new Set(
    Object.keys(
      buildChatWriteTools({
        memberRole: sessionMemberRole(role),
        organizationId: toSafeId<"organization">("org_1"),
        pinServerValidatedWorkspaceId: () => true,
        refRegistry: createChatRefRegistry(),
        safeDb: toSafeDbMock(noopScopedDb),
        scopedDb: noopScopedDb,
        toolDefectMemo: createChatToolDefectMemo(),
        toolWorkspaceIds: resolveToolWorkspaceIds({
          accessibleWorkspaceIds: [],
          pinnedIds: [],
        }),
        userEmail: "member@example.test",
        userId: toSafeId<"user">("user_1"),
        workspaceStatusById: new Map(),
      }),
    ),
  );

const ledgerId = (definition: McpToolDefinition): string | null => {
  if (definition.access !== "write") {
    return null;
  }
  const { type } = definition.permissions;
  return type === "all" ? null : `${definition.name}::${type}`;
};

describe("write tool permissions", () => {
  test("every write tool declares an authority some role can hold", () => {
    const definitions = writeDefinitions();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      if (definition.access !== "write") {
        continue;
      }
      const { permissions } = definition;
      expect(["all", "any", "delegated"]).toContain(permissions.type);
      if (permissions.type !== "all") {
        expect(permissions.reason.trim().length).toBeGreaterThan(0);
      }
      // An unsatisfiable declaration would hide the tool from everyone.
      expect({
        name: definition.name,
        owner: isMemberAuthorizedForMcpTool(
          sessionMemberRole("owner"),
          definition,
        ),
      }).toEqual({ name: definition.name, owner: true });
    }
  });

  test("declarations weaker than one exact grant are exactly the ledger", () => {
    const current = writeDefinitions()
      .map(ledgerId)
      .filter((id): id is string => id !== null)
      .toSorted();
    expect(current).toEqual(ledger.map((row) => row.id).toSorted());
    for (const row of ledger) {
      expect(row.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("MCP discovery offers no role a write tool its permissions do not grant", () => {
    expect(unauthorizedOffers(writeDefinitions(), mcpOffered)).toEqual([]);
  });

  test("chat registers no role a write tool its permissions do not grant", () => {
    expect(unauthorizedOffers(writeDefinitions(), chatOffered)).toEqual([]);
  });

  test("the gate withholds a write tool from a role without its grant", () => {
    expect(mcpOffered("external").has("delete_matter")).toBe(false);
    expect(chatOffered("external").has("delete_matter")).toBe(false);
    expect(mcpOffered("owner").has("delete_matter")).toBe(true);
  });

  test("dispatch refuses a write tool the role cannot hold before its handler runs", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: "matter_1", confirm: true },
      context: mcpContextFor("external"),
      toolName: "delete_matter",
    });
    expect(result.isError).toBe(true);
    const item = result.content.at(0);
    const payload: unknown =
      item?.type === "text" ? JSON.parse(item.text) : null;
    expect(payload).toEqual({
      error: {
        code: "permission_denied",
        message: "Your member role does not permit delete_matter",
      },
    });
  });
});

describe("write tool permissions self-test", () => {
  const fixture = {
    access: "write",
    name: "fixture_update_entity",
    permissions: { type: "all", permissions: { entity: ["update"] } },
  } as const satisfies McpToolAuthorityDeclaration & { name: string };

  test("a surface offering a write tool to a role without its grant fails the guard", () => {
    const offersEverything = () => new Set([fixture.name]);
    expect(unauthorizedOffers([fixture], offersEverything)).toContain(
      "external is offered fixture_update_entity",
    );
  });

  test("a write definition without declared permissions does not compile", () => {
    // Identical literals; only `permissions` differs, so the expected error
    // can only be its absence.
    const declared: McpToolDefinition = {
      access: "write",
      annotations: {
        title: "Fixture",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      consumesServices: false,
      description: "Fixture write tool",
      inputSchema: { type: "object" },
      name: "fixture_write",
      permissions: fixture.permissions,
      scope: "stella:read",
    };
    // @ts-expect-error -- the write branch requires `permissions`
    const undeclared: McpToolDefinition = {
      access: "write",
      annotations: {
        title: "Fixture",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      consumesServices: false,
      description: "Fixture write tool",
      inputSchema: { type: "object" },
      name: "fixture_write",
      scope: "stella:read",
    };
    expect(undeclared.name).toBe(declared.name);
  });
});

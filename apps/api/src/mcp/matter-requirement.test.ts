import { describe, expect, test } from "bun:test";

import { roles } from "@stll/permissions";

import { toSafeId } from "@/api/lib/branded-types";
import {
  matterRequiredResult,
  WRITE_TOOL_SCOPE,
  WRITE_TOOL_SCOPES,
  writeCallNeedsMatter,
} from "@/api/mcp/matter-requirement";
import type { McpWriteToolName } from "@/api/mcp/matter-requirement";
import { MANAGE_ORG_ACTIONS } from "@/api/mcp/research-admin-tools";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolInputSchema } from "@/api/mcp/tool-types";

const WORKSPACE_ID = toSafeId<"workspace">(
  "0dc54d0c-10d7-401d-897e-e801dbd0998c",
);

const registryWriteToolNames = DEFAULT_MCP_TOOL_DEFINITIONS.flatMap(
  (definition) => (definition.access === "write" ? [definition.name] : []),
);

const scopedToolNames = (scope: string): McpWriteToolName[] =>
  registryWriteToolNames.filter((name) => WRITE_TOOL_SCOPES[name] === scope);

const hintOf = (result: ReturnType<typeof matterRequiredResult>) =>
  result?.error.type === "structured" ? result.error.hint : undefined;

describe("write tool scope classification", () => {
  test("classifies exactly the registry's write tools", () => {
    expect(Object.keys(WRITE_TOOL_SCOPES).toSorted()).toEqual(
      registryWriteToolNames.toSorted(),
    );
  });

  test("classifies a tool that requires a matter id as matter-scoped", () => {
    const requiresMatterId = registryWriteToolNames.filter((name) => {
      const schema: McpToolInputSchema | undefined =
        getStaticMcpToolDefinition(name)?.inputSchema;
      const required = schema?.["required"];
      return Array.isArray(required) && required.includes("matter_id");
    });
    // The census must reach at least one tool, or it holds vacuously.
    expect(requiresMatterId.length).toBeGreaterThan(0);
    for (const name of requiresMatterId) {
      expect(WRITE_TOOL_SCOPES[name], name).toBe(WRITE_TOOL_SCOPE.matter);
    }
  });

  test("decides every manage_organization action", () => {
    const { byValue } = WRITE_TOOL_SCOPES.manage_organization;
    expect(Object.keys(byValue).toSorted()).toEqual(
      [...MANAGE_ORG_ACTIONS].toSorted(),
    );
    expect(
      writeCallNeedsMatter("manage_organization", { action: "add_member" }),
    ).toBe(true);
    expect(
      writeCallNeedsMatter("manage_organization", {
        action: "update_org_settings",
      }),
    ).toBe(false);
  });

  test("compares staged uploads without a matter, stored versions in one", () => {
    expect(
      writeCallNeedsMatter("compare_documents", {
        source: { type: "uploads" },
      }),
    ).toBe(false);
    for (const type of ["versions", "previous"]) {
      expect(
        writeCallNeedsMatter("compare_documents", { source: { type } }),
        type,
      ).toBe(true);
    }
  });

  test("keeps creating a matter and the organization library matter-free", () => {
    for (const name of [
      "save_matter",
      "save_playbook",
      "save_clause",
      "delete_clause",
      "create_template",
      "configure_template_fields",
      "save_contact",
      "set_practice_jurisdictions",
    ] as const) {
      expect(writeCallNeedsMatter(name, {}), name).toBe(false);
    }
  });
});

describe("needs-a-matter result", () => {
  const emptyOrg = {
    accessibleWorkspaceIds: [],
    memberRole: "owner",
  } satisfies Parameters<typeof matterRequiredResult>[0]["context"];

  test("answers every matter-scoped write in an organization with no matter", () => {
    const matterScoped = scopedToolNames(WRITE_TOOL_SCOPE.matter);
    expect(matterScoped).toContain("save_task");
    for (const toolName of matterScoped) {
      const result = matterRequiredResult({
        args: {},
        context: emptyOrg,
        saveMatterCallable: true,
        toolName,
      });
      expect(result?.error, toolName).toMatchObject({
        type: "structured",
        code: "not_found",
        retryable: false,
      });
      const hint = hintOf(result);
      expect(hint, toolName).toContain("save_matter");
      expect(hint, toolName).toContain("ask");
      expect(hint, toolName).toContain(`retry ${toolName}`);
    }
  });

  test("lets organization-scoped writes through with no matter", () => {
    for (const toolName of scopedToolNames(WRITE_TOOL_SCOPE.organization)) {
      expect(
        matterRequiredResult({
          args: {},
          context: emptyOrg,
          saveMatterCallable: true,
          toolName,
        }),
        toolName,
      ).toBeNull();
    }
  });

  test("lets matter-scoped writes through once a matter is reachable", () => {
    expect(
      matterRequiredResult({
        args: {},
        context: { ...emptyOrg, accessibleWorkspaceIds: [WORKSPACE_ID] },
        saveMatterCallable: true,
        toolName: "save_task",
      }),
    ).toBeNull();
  });

  test("sends a role that cannot create matters to someone who can", () => {
    expect(roles.intern.authorize({ workspace: ["create"] }).success).toBe(
      false,
    );
    const hint = hintOf(
      matterRequiredResult({
        args: {},
        context: { accessibleWorkspaceIds: [], memberRole: "intern" },
        saveMatterCallable: true,
        toolName: "save_task",
      }),
    );
    expect(hint).toContain("role cannot create");
    expect(hint).not.toContain("save_matter");
  });

  test("respects a credential that withholds matter creation", () => {
    const hint = hintOf(
      matterRequiredResult({
        args: {},
        context: {
          accessibleWorkspaceIds: [],
          credentialPermissions: { entity: ["create"] },
          memberRole: "owner",
        },
        saveMatterCallable: true,
        toolName: "save_task",
      }),
    );
    expect(hint).toContain("role cannot create");
  });

  test("names save_matter only to a session that can call it", () => {
    const hint = hintOf(
      matterRequiredResult({
        args: {},
        context: emptyOrg,
        saveMatterCallable: false,
        toolName: "save_task",
      }),
    );
    expect(hint).toContain("connection cannot create");
    expect(hint).not.toContain("save_matter");
  });

  test("ignores names outside the write registry", () => {
    expect(
      matterRequiredResult({
        args: {},
        context: emptyOrg,
        saveMatterCallable: true,
        toolName: "list_matters",
      }),
    ).toBeNull();
  });
});

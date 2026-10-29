import { panic } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import * as agentAccess from "@/api/mcp/agent-access";
import {
  AGENT_ACCESS_KIND,
  AGENT_CALL_SURFACE,
  decideAgentCall,
  describeAgentAccess,
} from "@/api/mcp/agent-access";
import type { AgentAccess, AgentAccessTarget } from "@/api/mcp/agent-access";
import { loadCapabilityCatalog } from "@/api/mcp/capability-tools";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import type {
  McpOperationDatabaseScope,
  McpRequestContext,
  McpRequestResources,
} from "@/api/mcp/context";
import { listGatewayMcpToolDefinitions } from "@/api/mcp/gateway/list-tools";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const MATTER_ID = "018f2a3e-4b5c-7d6e-8f90-a1b2c3d4e5f6";
const CALLER = { toolConfirmation: TOOL_CONFIRMATION.caller };
const AGENT_RUN = { toolConfirmation: TOOL_CONFIRMATION.unavailable };
const capabilityCatalog = await loadCapabilityCatalog();

const createContext = (
  toolConfirmation?: McpRequestContext["toolConfirmation"],
) => {
  const scopedDb = asTestRaw<
    McpOperationDatabaseScope["scopedDb"] & ReturnType<typeof mock>
  >(mock(async () => []));
  const accessibleWorkspaceIdSet = new Set(["ws_1"]);
  const context = {
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    accessibleWorkspaceIdSet,
    accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: MCP_OAUTH_SCOPES,
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
      mock(async () => undefined),
    ),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    createOperationDatabaseScope: () => ({
      pinServerValidatedWorkspaceId: (workspaceId) =>
        accessibleWorkspaceIdSet.has(workspaceId),
      safeDb: toSafeDbMock(scopedDb),
      scopedDb,
    }),
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
    ...(toolConfirmation === undefined ? {} : { toolConfirmation }),
  } satisfies McpRequestResources;
  return { context, scopedDb };
};

const errorCode = (result: Awaited<ReturnType<typeof handleMcpToolCall>>) => {
  const [content] = result.content;
  const text = content?.type === "text" ? content.text : "";
  if (!text.startsWith("{")) {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "code" in parsed.error
    ? parsed.error.code
    : null;
};

const toolTarget = (name: string): AgentAccessTarget => {
  const definition = DEFAULT_MCP_TOOL_DEFINITIONS.find(
    (tool) => tool.name === name,
  );
  if (definition === undefined) {
    return panic(`No static tool ${name}`);
  }
  return { type: "tool", name, access: definition.access };
};

const kindOf = (target: AgentAccessTarget) =>
  describeAgentAccess({ target, context: CALLER }).access.kind;

describe("agent access is resolved in one place", () => {
  test("the module exposes only the resolver's entry points", () => {
    // The classification maps stay private: every caller goes through
    // `decideAgentCall` or `describeAgentAccess`, directly or through the
    // helpers built on them (`finalAgentRefusal`, `describeForAgents`).
    expect(Object.keys(agentAccess).toSorted()).toEqual([
      "AGENT_ACCESS_KIND",
      "AGENT_CALL_SURFACE",
      "decideAgentCall",
      "describeAgentAccess",
      "describeForAgents",
      "finalAgentRefusal",
    ]);
  });

  test("no other module gates on confirmation, destructiveness, or agent runs", async () => {
    // The shapes the gates had before they moved behind the resolver. The
    // catalog's `destructive` flag stays as a client-facing label only.
    const root = path.resolve(import.meta.dir, "..");
    const bypasses = [
      /confirm"\]\s*!==\s*true/u,
      /\bconfirm\s*!==\s*true/u,
      /\.destructive\s*&&/u,
      /destructiveBehavior/u,
      /toolConfirmation\s*[!=]==/u,
    ];
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
      if (file.endsWith(".test.ts") || file === "mcp/agent-access.ts") {
        continue;
      }
      const source = await Bun.file(path.join(root, file)).text();
      for (const pattern of bypasses) {
        if (pattern.test(source)) {
          offenders.push(`${file}: ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("classification", () => {
  test("every registered capability has an explicit agent access classification", () => {
    expect(capabilityCatalog.length).toBeGreaterThan(0);
    for (const { id } of capabilityCatalog) {
      expect(kindOf({ type: "capability", id })).not.toBe("per-capability");
    }
  });

  test("read tools and read capabilities are open", () => {
    for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
      if (tool.access === "read") {
        expect({
          tool: tool.name,
          kind: kindOf(toolTarget(tool.name)),
        }).toEqual({ tool: tool.name, kind: AGENT_ACCESS_KIND.open });
      }
    }
    for (const entry of capabilityCatalog) {
      if (entry.access === "read") {
        expect({
          id: entry.id,
          kind: kindOf({ type: "capability", id: entry.id }),
        }).toEqual({ id: entry.id, kind: AGENT_ACCESS_KIND.open });
      }
    }
  });

  test("no destructive capability is open", () => {
    const open = capabilityCatalog
      .filter(
        (entry) =>
          entry.destructive &&
          kindOf({ type: "capability", id: entry.id }) ===
            AGENT_ACCESS_KIND.open,
      )
      .map((entry) => entry.id);
    expect(open).toEqual([]);
  });

  test("a curated tool and the capability it serves agree", () => {
    for (const { id, mcp } of capabilityCatalog) {
      if (mcp.type !== "tool" || !("name" in mcp)) {
        continue;
      }
      expect({
        capability: id,
        tool: mcp.name,
        access: kindOf(toolTarget(mcp.name)),
      }).toEqual({
        capability: id,
        tool: mcp.name,
        access: kindOf({ type: "capability", id }),
      });
    }
  });

  test("membership changes need a person's approval and deleting a matter is person-only", () => {
    expect(kindOf(toolTarget("add_matter_member"))).toBe(
      AGENT_ACCESS_KIND.personApproves,
    );
    expect(kindOf(toolTarget("remove_matter_member"))).toBe(
      AGENT_ACCESS_KIND.personApproves,
    );
    expect(kindOf(toolTarget("delete_document"))).toBe(
      AGENT_ACCESS_KIND.personApproves,
    );
    expect(kindOf(toolTarget("delete_matter"))).toBe(
      AGENT_ACCESS_KIND.personOnly,
    );
    expect(kindOf({ type: "capability", id: "matters.members.add" })).toBe(
      AGENT_ACCESS_KIND.personApproves,
    );
    expect(kindOf({ type: "capability", id: "matters.delete" })).toBe(
      AGENT_ACCESS_KIND.personOnly,
    );
  });

  test("organization-wide settings changes need a person's approval", () => {
    // The sender list is a read the catalog files under write (it needs the
    // settings grant); every other settings write changes the organization.
    const reads = new Set([
      "organization-settings.correspondence.allowed-senders.list",
    ]);
    const settingsWrites = capabilityCatalog.filter(
      ({ id, access }) =>
        id.startsWith("organization-settings.") &&
        access === "write" &&
        !reads.has(id),
    );
    expect(settingsWrites.length).toBeGreaterThan(0);
    const changesSettings = {
      kind: AGENT_ACCESS_KIND.personApproves,
      reason: "changes-organization-settings",
    } as const satisfies AgentAccess;
    for (const { id } of settingsWrites) {
      expect({
        id,
        access: describeAgentAccess({
          target: { type: "capability", id },
          context: CALLER,
        }).access,
      }).toEqual({ id, access: changesSettings });
    }
    for (const name of [
      "update_organization_settings",
      "set_practice_jurisdictions",
    ]) {
      expect(
        describeAgentAccess({ target: toolTarget(name), context: CALLER })
          .access,
      ).toEqual(changesSettings);
    }
    for (const id of reads) {
      expect(kindOf({ type: "capability", id })).toBe(AGENT_ACCESS_KIND.open);
    }
  });

  test("an unclassified target is a defect, not an open door", () => {
    expect(() =>
      describeAgentAccess({
        target: { type: "capability", id: "not.a.capability" },
        context: CALLER,
      }),
    ).toThrow("has no agent access");
    expect(() =>
      describeAgentAccess({
        target: { type: "tool", name: "not_a_tool", access: "write" },
        context: CALLER,
      }),
    ).toThrow("has no agent access");
  });
});

describe("decisions", () => {
  const decide = ({
    target,
    surface,
    confirmed,
    context = CALLER,
  }: {
    target: AgentAccessTarget;
    surface: keyof typeof AGENT_CALL_SURFACE;
    confirmed: boolean;
    context?: typeof CALLER | typeof AGENT_RUN;
  }) =>
    decideAgentCall({
      target,
      context,
      surface: AGENT_CALL_SURFACE[surface],
      subject: "the call",
      confirmed,
    });

  test("a caller-confirmed write runs only with confirm over MCP", () => {
    const target = toolTarget("delete_task");
    expect(decide({ target, surface: "mcp", confirmed: false })).toMatchObject({
      type: "refuse",
      refusal: { code: "confirmation_required" },
    });
    expect(decide({ target, surface: "mcp", confirmed: true })).toEqual({
      type: "allow",
      approval: "confirmed",
    });
  });

  test("an agent run hands a caller-confirmed write back to a person", () => {
    expect(
      decide({
        target: toolTarget("delete_task"),
        surface: "mcp",
        confirmed: true,
        context: AGENT_RUN,
      }),
    ).toMatchObject({
      type: "refuse",
      refusal: { code: "person_approval_required" },
    });
  });

  test("confirm never stands in for a person's approval or a person's action", () => {
    for (const name of ["add_matter_member", "remove_matter_member"]) {
      expect(
        decide({ target: toolTarget(name), surface: "mcp", confirmed: true }),
      ).toMatchObject({
        type: "refuse",
        refusal: { code: "person_approval_required" },
      });
    }
    expect(
      decide({
        target: toolTarget("delete_matter"),
        surface: "mcp",
        confirmed: true,
      }),
    ).toMatchObject({ type: "refuse", refusal: { code: "person_only" } });
  });

  test("stella's chat approval step admits approval writes but never person-only ones", () => {
    expect(
      decide({
        target: toolTarget("add_matter_member"),
        surface: "chat",
        confirmed: false,
      }),
    ).toEqual({ type: "allow", approval: "confirmed" });
    expect(
      decide({
        target: toolTarget("delete_matter"),
        surface: "chat",
        confirmed: false,
      }),
    ).toMatchObject({ type: "refuse", refusal: { code: "person_only" } });
  });

  test("the generic executor defers to the capability it selects", () => {
    expect(
      decide({
        target: toolTarget(MCP_CAPABILITY_EXECUTORS.write),
        surface: "mcp",
        confirmed: false,
      }),
    ).toEqual({ type: "allow", approval: "none" });
  });
});

describe("transport boundary", () => {
  // These tools declare no `confirm`, so sending it is an input error; with or
  // without it, the handler never runs.
  test.each([
    {
      tool: "add_matter_member",
      args: { matter_id: MATTER_ID, user_id: "user_2" },
      code: "person_approval_required",
    },
    {
      tool: "delete_matter",
      args: { matter_id: MATTER_ID },
      code: "person_only",
    },
    {
      tool: "update_organization_settings",
      args: { prompt_caching_enabled: true },
      code: "person_approval_required",
    },
  ])(
    "$tool does not run from an MCP caller, even with confirm",
    async ({ tool, args, code }) => {
      const { context, scopedDb } = createContext();
      const refused = await handleMcpToolCall({
        args,
        context,
        toolName: tool,
      });
      expect(errorCode(refused)).toBe(code);

      const withConfirm = await handleMcpToolCall({
        args: { ...args, confirm: true },
        context,
        toolName: tool,
      });
      expect(withConfirm.isError).toBe(true);
      expect(scopedDb).not.toHaveBeenCalled();
    },
  );

  test("the generic executor refuses the same capabilities", async () => {
    const { context, scopedDb } = createContext();
    const call = async (capability: string) =>
      errorCode(
        await handleMcpToolCall({
          args: {
            capability,
            input: { params: { matterId: MATTER_ID } },
            confirm: true,
          },
          context,
          mode: "advanced",
          toolName: MCP_CAPABILITY_EXECUTORS.write,
        }),
      );
    expect(await call("matters.delete")).toBe("person_only");
    expect(await call("matters.members.add")).toBe("person_approval_required");
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("an agent run is handed back before the handler touches data", async () => {
    const { context, scopedDb } = createContext(TOOL_CONFIRMATION.unavailable);
    const result = await handleMcpToolCall({
      args: { task_id: MATTER_ID, confirm: true },
      context,
      toolName: "delete_task",
    });
    expect(errorCode(result)).toBe("person_approval_required");
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("tools a person runs or approves stay listed and say so", async () => {
    const listed = await listGatewayMcpToolDefinitions({
      context: createContext().context,
      mode: "default",
      scopes: MCP_OAUTH_SCOPES,
    });
    const descriptionOf = (name: string) =>
      listed.find((tool) => tool.name === name)?.description ?? "";

    expect(descriptionOf("delete_matter")).toContain(
      "Only a person can do this",
    );
    expect(descriptionOf("add_matter_member")).toContain(
      "Needs a person's approval in stella",
    );
    expect(descriptionOf("list_documents")).not.toContain("a person");
  });
});

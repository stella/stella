import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const materializePlaybookRunMock = mock();
const startWorkflowMock = mock();

const realMaterializeRun =
  await import("@/api/handlers/playbooks/materialize-run");
const realWorkflowQueue = await import("@/api/lib/workflow-queue");

void mock.module("@/api/handlers/playbooks/materialize-run", () => ({
  ...realMaterializeRun,
  materializePlaybookRun: materializePlaybookRunMock,
}));

void mock.module("@/api/lib/workflow-queue", () => ({
  ...realWorkflowQueue,
  startWorkflow: startWorkflowMock,
}));

const { handleMcpToolCall, listMcpTools } = await import("@/api/mcp/tools");
const { KNOWLEDGE_TOOL_HANDLERS } = await import("@/api/mcp/knowledge-tools");

const parseToolPayload = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): unknown => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(item.text) as unknown;
};

/** A scopedDb whose select chain resolves to the seeded clause rows. */
const createClauseScopedDb = (rows: unknown[]) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(async (run: (tx: unknown) => unknown) => {
      const builder = {
        select: () => builder,
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: async () => rows,
      };
      return await run(builder);
    }),
  );

/** A scopedDb whose playbookDefinitions.findFirst resolves to `playbook`. */
const createPlaybookScopedDb = (playbook: unknown) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(
      async (run: (tx: unknown) => unknown) =>
        await run({
          query: {
            playbookDefinitions: { findFirst: async () => playbook },
          },
        }),
    ),
  );

/** A scopedDb whose clauses.findFirst resolves to `clause` (detail mode). */
const createClauseDetailScopedDb = (clause: unknown) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(
      async (run: (tx: unknown) => unknown) =>
        await run({
          query: {
            clauses: { findFirst: async () => clause },
          },
        }),
    ),
  );

const createContext = ({
  memberRole = "owner",
  scopedDb = createClauseScopedDb([]),
}: {
  memberRole?: McpRequestContext["memberRole"];
  scopedDb?: McpRequestContext["scopedDb"];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
  accessibleWorkspaceIdSet: new Set(["ws_1"]),
  accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  ),
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

describe("MCP knowledge tools", () => {
  beforeEach(() => {
    materializePlaybookRunMock.mockReset();
    startWorkflowMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  test("read tools project onto the anonymized surface; writes do not", async () => {
    const names = (await listMcpTools(createContext(), "anonymized")).map(
      (tool) => tool.name,
    );
    expect(names).toContain("list_clauses");
    expect(names).toContain("list_playbooks");
    expect(names).not.toContain("save_clause");
    expect(names).not.toContain("delete_clause");
    expect(names).not.toContain("run_playbook");
  });

  test("list_clauses declares tenant text fields that redact the payload in place", async () => {
    const rows = [
      {
        id: "c1",
        title: "Governing Law",
        categoryId: null,
        language: "en",
        description: "England and Wales",
        currentVersion: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
      args: {},
      context: createContext({ scopedDb: createClauseScopedDb(rows) }),
    });
    if (!isMcpEgressPlan(response) || response.egress !== "structured") {
      throw new Error("Expected a structured egress plan");
    }

    // The declared text fields are the tenant-authored title and description,
    // in push order, under the organization scope (clauses are org-scoped).
    expect(response.textFields.map((field) => field.value)).toEqual([
      "Governing Law",
      "England and Wales",
    ]);
    expect(
      response.textFields.every((field) => field.workspaceId === "org_1"),
    ).toBe(true);

    // The egress pipeline redacts each declared field and writes it back through
    // `apply`; simulate that and confirm the payload mutates in place.
    for (const [index, field] of response.textFields.entries()) {
      field.apply(`[REDACTED_${index}]`);
    }
    expect(response.payload).toMatchObject({
      clauses: [{ title: "[REDACTED_0]", description: "[REDACTED_1]" }],
      nextCursor: null,
    });
  });

  test("list_clauses fails closed when a clause body is unrecognized, leaking nothing", async () => {
    const clause = {
      id: "c1",
      title: "Governing Law",
      categoryId: null,
      description: null,
      usageNotes: null,
      language: null,
      // Malformed: a clause body must be a non-empty paragraph array; a raw
      // string here mimics a corrupted or hand-edited row.
      body: "SECRET_UNREDACTED_MARKER",
      metadata: null,
      currentVersion: 1,
      createdBy: "user_1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      variants: [],
      versions: [],
    };

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
      args: { clause_id: "c1" },
      context: createContext({
        scopedDb: createClauseDetailScopedDb(clause),
      }),
    });

    expect(isMcpEgressPlan(response)).toBe(false);
    if (isMcpEgressPlan(response)) {
      throw new Error("Expected a finished error result, not an egress plan");
    }
    expect(response.isError).toBe(true);
    const message = response.content.at(0);
    const parsed =
      message?.type === "text" ? JSON.parse(message.text) : undefined;
    expect(parsed).toEqual({
      error: {
        code: "validation_error",
        message: "Clause body has an unrecognized format",
        issues: [
          { path: "body", message: "Clause body has an unrecognized format" },
        ],
      },
    });
    // The malformed body must never reach the payload, anonymized or not.
    expect(JSON.stringify(response)).not.toContain("SECRET_UNREDACTED_MARKER");
  });

  test("save_clause rejects an update that changes nothing", async () => {
    const result = await handleMcpToolCall({
      args: { clause_id: "c1" },
      context: createContext(),
      toolName: "save_clause",
    });

    expect(result.isError).toBe(true);
    const message = result.content.at(0);
    expect(message?.type === "text" ? message.text : "").toContain(
      "Provide at least one field to change",
    );
  });

  test("run_playbook materializes columns and queues the review workflow", async () => {
    materializePlaybookRunMock.mockResolvedValue({
      ok: true,
      materializedPropertyIds: [
        toSafeId<"property">("p1"),
        toSafeId<"property">("p2"),
      ],
    });
    startWorkflowMock.mockResolvedValue(undefined);

    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1", playbook_id: "pb_1" },
      context: createContext({
        scopedDb: createPlaybookScopedDb({
          positions: { version: 2, items: [] },
          scope: null,
        }),
      }),
      toolName: "run_playbook",
    });

    expect(result.isError).toBeFalsy();
    expect(parseToolPayload(result)).toEqual({ runPropertyCount: 2 });
    expect(materializePlaybookRunMock).toHaveBeenCalledTimes(1);
    expect(startWorkflowMock).toHaveBeenCalledTimes(1);
    expect(startWorkflowMock.mock.calls.at(0)?.[0]).toMatchObject({
      propertyIds: [toSafeId<"property">("p1"), toSafeId<"property">("p2")],
      workspaceId: "ws_1",
    });
  });
});

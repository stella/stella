import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const materializePlaybookRunMock = mock();
const startWorkflowMock = mock();
// The two database reads `openPlaybookRun` makes around the materializer. The
// opener itself, and the pin resolution inside it, stay real: they are what
// this suite checks the tool for.
const loadLatestApprovedVersionMock = mock();
const createPlaybookTableRunsMock = mock();

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

// Ids that reach `uuid` columns are validated as UUIDs by the tool input
// schemas, so the fixtures use well-formed ones. Each id has one value shared by
// the tool input, the mocked row, and the assertion.
const MATTER_ID = "00000000-0000-4000-8000-000000000001";
const CLAUSE_ID = "00000000-0000-4000-8000-000000000002";
const PLAYBOOK_ID = toSafeId<"playbookDefinition">(
  "00000000-0000-4000-8000-000000000003",
);
const APPROVED_VERSION_ID = toSafeId<"playbookDefinitionVersion">(
  "00000000-0000-4000-8000-000000000004",
);

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

/**
 * A playbook's positions, tagged by the issue text so the approved snapshot and
 * the live definition are told apart by every assertion below.
 *
 * A factory rather than a shared constant: `toMatchObject` walks the objects it
 * is handed, and a fixture reused across assertions must not carry state from
 * one into the next.
 */
const positionsSaying = (issue: string) => ({
  version: 3,
  items: [
    {
      mode: "extract",
      sourceId: "11111111-1111-4111-8111-111111111111",
      issue,
      ask: {
        question: "What is the notice period?",
        content: { version: 1, type: "text" },
      },
      enabled: true,
    },
  ],
});

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

/**
 * A scopedDb standing in for the clause-create write path, capturing every
 * body `createClauseHandler` hands the insert so the persisted shape can be
 * asserted against the snake_case MCP input.
 */
const createClauseWriteScopedDb = () => {
  const insertedBodies: unknown[] = [];
  const scopedDb = asTestRaw<
    McpRequestContext["scopedDb"] & ReturnType<typeof mock>
  >(
    mock(async (run: (tx: unknown) => unknown) => {
      const tx = {
        $count: async () => 0,
        insert: () => ({
          values: (row: { body?: unknown }) => {
            if (row.body !== undefined) {
              insertedBodies.push(row.body);
            }
            return { returning: async () => [{ id: CLAUSE_ID }] };
          },
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      };
      return await run(tx);
    }),
  );
  return { insertedBodies, scopedDb };
};

const STORED_UPDATED_AT = new Date("2026-09-20T10:00:00.000Z");
const STORED_EXTRACT_POSITION = {
  mode: "extract",
  sourceId: "00000000-0000-4000-8000-0000000000a1",
  issue: "Governing law",
  ask: {
    question: "Which law governs the agreement?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
} as const;
const STORED_PLAYBOOK = {
  id: PLAYBOOK_ID,
  name: "NDA playbook",
  description: "Inbound NDAs",
  scope: { perspective: "buyer", trigger: "onClassified" },
  positions: { version: 3, items: [STORED_EXTRACT_POSITION] },
  status: "approved",
  approvedAt: null,
  createdAt: STORED_UPDATED_AT,
  updatedAt: STORED_UPDATED_AT,
} as const;

/**
 * A scopedDb standing in for the playbook write paths: the detail read, the
 * locked `updatedAt` read, and the insert/update, capturing what each write
 * was handed. Extract-only positions keep `deriveAutoAsks` off the model.
 */
const createPlaybookWriteScopedDb = ({
  lockedUpdatedAt = STORED_UPDATED_AT,
}: { lockedUpdatedAt?: Date } = {}) => {
  const writes: Record<string, unknown>[] = [];
  const savedAt = new Date("2026-09-20T10:05:00.000Z");
  const scopedDb = asTestRaw<
    McpRequestContext["scopedDb"] & ReturnType<typeof mock>
  >(
    mock(async (run: (tx: unknown) => unknown) => {
      const tx = {
        $count: async () => 0,
        query: {
          documentTypes: { findFirst: async () => undefined },
          playbookDefinitions: {
            findFirst: async () => ({
              ...STORED_PLAYBOOK,
              ...(writes.length === 0 ? {} : { updatedAt: savedAt }),
            }),
          },
        },
        select: () => ({
          from: () => ({
            where: () => ({
              for: async () => [{ updatedAt: lockedUpdatedAt }],
            }),
          }),
        }),
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            writes.push(row);
            return { returning: async () => [{ id: PLAYBOOK_ID }] };
          },
        }),
        update: () => ({
          set: (row: Record<string, unknown>) => {
            writes.push(row);
            return {
              where: () => ({
                returning: async () => [{ updatedAt: savedAt }],
              }),
            };
          },
        }),
      };
      return await run(tx);
    }),
  );
  return { savedAt, scopedDb, writes };
};

const createPlaybookWriteContext = (
  scopedDb: McpRequestContext["scopedDb"],
): McpRequestContext => {
  const context = createContext({ scopedDb });
  return {
    ...context,
    testDependencies: {
      ...context.testDependencies,
      loadOrgSettingsForAuth: async () => ({
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        promptCachingEnabled: false,
      }),
    },
  };
};

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
  accessibleWorkspaceIds: [toSafeId<"workspace">(MATTER_ID)],
  accessibleWorkspaceIdSet: new Set([MATTER_ID]),
  accessibleWorkspaceStatusById: new Map([[MATTER_ID, "active"]]),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  ),
  testDependencies: {
    materializePlaybookRun: materializePlaybookRunMock,
    startWorkflow: startWorkflowMock,
    loadLatestApprovedVersion: loadLatestApprovedVersionMock,
    createPlaybookTableRuns: createPlaybookTableRunsMock,
  },
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

describe("MCP knowledge tools", () => {
  beforeEach(() => {
    materializePlaybookRunMock.mockReset();
    startWorkflowMock.mockReset();
    loadLatestApprovedVersionMock.mockReset();
    createPlaybookTableRunsMock.mockReset();
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
        id: CLAUSE_ID,
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
    if (!isMcpEgressPlan(response)) {
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
      id: CLAUSE_ID,
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
      args: { clause_id: CLAUSE_ID },
      context: createContext({
        scopedDb: createClauseDetailScopedDb(clause),
      }),
    });

    expect(isMcpEgressPlan(response)).toBe(false);
    if (isMcpEgressPlan(response)) {
      throw new Error("Expected a finished error result, not an egress plan");
    }
    expect(response).toEqual({
      status: "error",
      error: {
        type: "structured",
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

  test("save_clause refuses a camelCase body paragraph key", async () => {
    const result = await handleMcpToolCall({
      args: {
        title: "Indemnity",
        body: [{ text: "The Supplier shall indemnify.", listKind: "bullet" }],
      },
      context: createContext(),
      toolName: "save_clause",
    });

    expect(result.isError).toBe(true);
    expect(parseToolPayload(result)).toMatchObject({
      error: {
        code: "validation_error",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "body.0.listKind" }),
        ]),
      },
    });
  });

  test("save_clause maps snake_case paragraph keys onto the persisted body", async () => {
    const { insertedBodies, scopedDb } = createClauseWriteScopedDb();

    const result = await handleMcpToolCall({
      args: {
        title: "Indemnity",
        body: [
          {
            text: "The Supplier shall indemnify.",
            runs: [{ text: "The Supplier shall indemnify.", bold: true }],
            list_kind: "bullet",
            list_level: 1,
            is_directive: true,
            directive_kind: "if",
            directive_expression: "party.isSupplier",
          },
        ],
      },
      context: createContext({ scopedDb }),
      toolName: "save_clause",
    });

    expect(result.isError).toBeFalsy();
    expect(insertedBodies).not.toBeEmpty();
    for (const body of insertedBodies) {
      expect(body).toEqual([
        {
          text: "The Supplier shall indemnify.",
          runs: [{ text: "The Supplier shall indemnify.", bold: true }],
          listKind: "bullet",
          listLevel: 1,
          isDirective: true,
          directiveKind: "if",
          directiveExpression: "party.isSupplier",
        },
      ]);
    }
  });

  test("save_clause rejects an update that changes nothing", async () => {
    const result = await handleMcpToolCall({
      args: { clause_id: CLAUSE_ID },
      context: createContext(),
      toolName: "save_clause",
    });

    expect(result.isError).toBe(true);
    const message = result.content.at(0);
    expect(message?.type === "text" ? message.text : "").toContain(
      "Provide at least one field to change",
    );
  });

  test("save_playbook creates from a name and returns the next save's token", async () => {
    const { savedAt, scopedDb, writes } = createPlaybookWriteScopedDb();

    const result = await handleMcpToolCall({
      args: {
        name: "MSA playbook",
        positions: [
          {
            mode: "extract",
            issue: "Term",
            // A model's way of saying "nothing here", inside a union member.
            guidance: null,
            ask: { question: "How long is the term?", answer_type: "INT " },
          },
        ],
      },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(result.isError).toBeFalsy();
    const [inserted] = writes;
    expect(inserted?.["name"]).toBe("MSA playbook");
    expect(inserted?.["positions"]).toMatchObject({
      version: 3,
      items: [
        {
          mode: "extract",
          issue: "Term",
          ask: { content: { version: 1, type: "int" } },
          enabled: true,
        },
      ],
    });
    expect(parseToolPayload(result)).toMatchObject({
      playbookId: PLAYBOOK_ID,
      updatedAt: savedAt.toISOString(),
      positionCount: 1,
      positions: [{ issue: "Term", change: "added" }],
      issues: [],
    });
  });

  test("save_playbook stores an empty scope as unscoped", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb();

    const result = await handleMcpToolCall({
      args: { name: "NDA playbook", scope: {} },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(result.isError).toBeFalsy();
    expect(writes[0]?.["scope"]).toBeNull();
  });

  test("save_playbook keeps the stored name, description, scope, and unnamed positions on an update", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb();

    const result = await handleMcpToolCall({
      args: {
        playbook_id: PLAYBOOK_ID,
        expected_updated_at: STORED_UPDATED_AT.toISOString(),
        scope: { perspective: "seller" },
        positions: [
          {
            mode: "extract",
            issue: "Term",
            ask: { question: "How long is the term?" },
          },
        ],
      },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(result.isError).toBeFalsy();
    const [updated] = writes;
    expect(updated?.["name"]).toBe(STORED_PLAYBOOK.name);
    expect(updated?.["description"]).toBe(STORED_PLAYBOOK.description);
    expect(updated?.["scope"]).toEqual({
      perspective: "seller",
      trigger: "onClassified",
    });
    expect(updated?.["status"]).toBe("draft");
    expect(updated?.["positions"]).toMatchObject({
      items: [STORED_EXTRACT_POSITION, { issue: "Term" }],
    });
  });

  test.each([
    ["no positions", { positions: [] }],
    ["no removals", { remove_source_ids: [] }],
    [
      "the stored definition fields",
      {
        name: STORED_PLAYBOOK.name,
        description: STORED_PLAYBOOK.description,
        scope: { perspective: STORED_PLAYBOOK.scope.perspective },
      },
    ],
    [
      "a position as it is stored",
      {
        positions: [
          {
            mode: "extract",
            source_id: STORED_EXTRACT_POSITION.sourceId,
            issue: STORED_EXTRACT_POSITION.issue,
            ask: { question: STORED_EXTRACT_POSITION.ask.question },
          },
        ],
      },
    ],
  ])(
    "save_playbook leaves an approved playbook alone when the call sends %s",
    async (_label, change) => {
      const { scopedDb, writes } = createPlaybookWriteScopedDb();

      const result = await handleMcpToolCall({
        args: {
          playbook_id: PLAYBOOK_ID,
          expected_updated_at: STORED_UPDATED_AT.toISOString(),
          ...change,
        },
        context: createPlaybookWriteContext(scopedDb),
        toolName: "save_playbook",
      });

      expect(result.isError).toBeFalsy();
      expect(writes).toEqual([]);
      expect(parseToolPayload(result)).toMatchObject({
        updatedAt: STORED_UPDATED_AT.toISOString(),
        positions: [],
        removed: [],
      });
    },
  );

  test("save_playbook answers a stale token with the calls that recover from it", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb({
      lockedUpdatedAt: new Date("2026-09-20T10:03:00.000Z"),
    });

    const result = await handleMcpToolCall({
      args: {
        playbook_id: PLAYBOOK_ID,
        expected_updated_at: STORED_UPDATED_AT.toISOString(),
        name: "Renamed",
      },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(result.isError).toBe(true);
    expect(writes).toEqual([]);
    expect(parseToolPayload(result)).toMatchObject({
      error: {
        code: "conflict",
        hint: expect.stringContaining("list_playbooks with playbook_id"),
      },
    });
  });

  test("save_playbook writes nothing when every entry is refused, and says how to fix each", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb();

    const result = await handleMcpToolCall({
      args: {
        playbook_id: PLAYBOOK_ID,
        expected_updated_at: STORED_UPDATED_AT.toISOString(),
        positions: [
          {
            mode: "extract",
            issue: "governing law",
            ask: { question: "Which law governs?" },
          },
        ],
      },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(result.isError).toBe(true);
    expect(writes).toEqual([]);
    expect(parseToolPayload(result)).toMatchObject({
      error: {
        code: "validation_error",
        issues: [
          {
            path: "positions.0.issue",
            message: expect.stringContaining(STORED_EXTRACT_POSITION.sourceId),
          },
        ],
        hint: expect.stringContaining("source_id"),
      },
    });
  });

  test("save_playbook refuses a graded entry with nothing to grade against and saves the entries beside it", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb();

    const result = await handleMcpToolCall({
      args: {
        playbook_id: PLAYBOOK_ID,
        expected_updated_at: STORED_UPDATED_AT.toISOString(),
        positions: [
          {
            mode: "extract",
            issue: "Term",
            ask: { question: "How long is the term?" },
          },
          {
            mode: "graded",
            issue: "Liability cap",
            severity: "high",
            tiers: { ideal: "" },
          },
        ],
      },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(result.isError).toBeFalsy();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.["positions"]).toMatchObject({
      items: [STORED_EXTRACT_POSITION, { issue: "Term" }],
    });
    expect(parseToolPayload(result)).toMatchObject({
      positions: [{ issue: "Term", change: "added" }],
      issues: [
        {
          code: "empty_tiers",
          path: "positions.1.tiers",
          hint: expect.stringContaining("mode extract"),
        },
      ],
    });
  });

  test("save_playbook answers a guessed document type key with the way out", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb();

    const result = await handleMcpToolCall({
      args: { name: "Inbound NDA", scope: { document_type_key: "nda" } },
      context: createPlaybookWriteContext(scopedDb),
      toolName: "save_playbook",
    });

    expect(writes).toEqual([]);
    expect(parseToolPayload(result)).toMatchObject({
      error: {
        code: "validation_error",
        issues: [{ path: "scope.document_type_key" }],
        hint: expect.stringContaining("Leave scope.document_type_key out"),
      },
    });
  });

  test("save_playbook requires a name to create and a token to update", async () => {
    const { scopedDb, writes } = createPlaybookWriteScopedDb();
    const context = createPlaybookWriteContext(scopedDb);

    const noName = await handleMcpToolCall({
      args: { description: "No name" },
      context,
      toolName: "save_playbook",
    });
    const noToken = await handleMcpToolCall({
      args: { playbook_id: PLAYBOOK_ID, name: "Renamed" },
      context,
      toolName: "save_playbook",
    });

    expect(writes).toEqual([]);
    expect(parseToolPayload(noName)).toMatchObject({
      error: { code: "validation_error", issues: [{ path: "name" }] },
    });
    expect(parseToolPayload(noToken)).toMatchObject({
      error: {
        code: "validation_error",
        issues: [{ path: "expected_updated_at" }],
      },
    });
  });

  test("run_playbook reviews the approved snapshot, opens its runs, and queues the workflow", async () => {
    // The playbook was edited after it was approved. Everything the tool does
    // must come from the approved snapshot: a review an agent started must be
    // measured against the same standard the HTTP surfaces measure against,
    // not against whatever the definition said at that moment.
    loadLatestApprovedVersionMock.mockResolvedValue({
      id: APPROVED_VERSION_ID,
      name: "Approved name",
      positions: positionsSaying("As approved"),
    });
    materializePlaybookRunMock.mockResolvedValue({
      ok: true,
      materializedPropertyIds: [
        toSafeId<"property">("p1"),
        toSafeId<"property">("p2"),
      ],
    });
    createPlaybookTableRunsMock.mockResolvedValue({
      runs: [{ runId: toSafeId<"documentReviewRun">("run_1"), entityId: "e1" }],
      skippedActiveCount: 0,
      uncoveredCount: 0,
      expectedFindingCount: 1,
    });
    startWorkflowMock.mockResolvedValue({ status: "started" });

    const result = await handleMcpToolCall({
      args: { matter_id: MATTER_ID, playbook_id: PLAYBOOK_ID },
      context: createContext({
        scopedDb: createPlaybookScopedDb({
          id: PLAYBOOK_ID,
          name: "Live draft name",
          positions: positionsSaying("Edited after approval"),
          scope: null,
        }),
      }),
      toolName: "run_playbook",
    });

    expect(result.isError).toBeFalsy();
    expect(parseToolPayload(result)).toEqual({ runPropertyCount: 2 });

    // Columns still materialize, but from the snapshot rather than the live
    // definition: the cell a lawyer reads on the table and the finding the run
    // records answer the same question.
    expect(materializePlaybookRunMock).toHaveBeenCalledTimes(1);
    expect(materializePlaybookRunMock.mock.calls.at(0)?.[0]).toMatchObject({
      playbookId: PLAYBOOK_ID,
      positions: positionsSaying("As approved").items,
    });

    // And a durable run per document, pinned to the version it was measured
    // against, projected onto the table the tool materialized into.
    expect(createPlaybookTableRunsMock).toHaveBeenCalledTimes(1);
    expect(createPlaybookTableRunsMock.mock.calls.at(0)?.[0]).toMatchObject({
      workspaceId: MATTER_ID,
      userId: "user_1",
      projection: "columns",
      docTypeGate: null,
      playbook: {
        definitionId: PLAYBOOK_ID,
        versionId: APPROVED_VERSION_ID,
        provenance: "approved",
        definitionSnapshot: {
          name: "Approved name",
          positions: positionsSaying("As approved"),
        },
      },
    });

    expect(startWorkflowMock).toHaveBeenCalledTimes(1);
    expect(startWorkflowMock.mock.calls.at(0)?.[0]).toMatchObject({
      propertyIds: [toSafeId<"property">("p1"), toSafeId<"property">("p2")],
      workspaceId: MATTER_ID,
    });
  });

  test("run_playbook reports a workflow that never started instead of a run count", async () => {
    loadLatestApprovedVersionMock.mockResolvedValue(null);
    materializePlaybookRunMock.mockResolvedValue({
      ok: true,
      materializedPropertyIds: [toSafeId<"property">("p1")],
    });
    createPlaybookTableRunsMock.mockResolvedValue({
      runs: [{ runId: toSafeId<"documentReviewRun">("run_1"), entityId: "e1" }],
      skippedActiveCount: 0,
      uncoveredCount: 0,
      expectedFindingCount: 1,
    });
    // The queue reports an enqueue failure in-band rather than throwing.
    startWorkflowMock.mockResolvedValue({ status: "failed" });

    const result = await handleMcpToolCall({
      args: { matter_id: MATTER_ID, playbook_id: PLAYBOOK_ID },
      context: createContext({
        scopedDb: createPlaybookScopedDb({
          id: PLAYBOOK_ID,
          name: "Live draft name",
          positions: positionsSaying("Never approved"),
          scope: null,
        }),
      }),
      toolName: "run_playbook",
    });

    expect(result.isError).toBe(true);
    // Retryable by construction: the materialized columns survive, so calling
    // the tool again maps back to them instead of materializing a second set.
    expect(parseToolPayload(result)).toMatchObject({
      error: {
        code: "internal_error",
        message: "Failed to start the review",
        retryable: true,
      },
    });
  });
});

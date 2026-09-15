import { describe, expect, test } from "bun:test";

import { chatThreads, docxSuggestions, entities } from "@/api/db/schema";
import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

type CreateDocxSuggestionsContext = Parameters<
  typeof createDocxSuggestions.handler
>[0];

const WORKSPACE_ID = toSafeId<"workspace">(
  "11111111-1111-4111-8111-111111111111",
);
const CONTRIBUTING_WORKSPACE_ID = toSafeId<"workspace">(
  "22222222-2222-4222-8222-222222222222",
);
const ENTITY_ID = toSafeId<"entity">("33333333-3333-4333-8333-333333333333");
const THREAD_ID = toSafeId<"chatThread">(
  "44444444-4444-4444-8444-444444444444",
);

type OriginThreadRow = {
  workspaceId: SafeId<"workspace">;
  dataWorkspaceIds: SafeId<"workspace">[];
};

// The rows the handler reads, per table: the origin thread lookup, the
// document row lock, and the pending-count read.
const rowsForTable = (
  table: unknown,
  thread: OriginThreadRow | null,
): unknown[] => {
  if (table === docxSuggestions) {
    return [{ pending: 0 }];
  }
  if (table === entities) {
    return [{ id: ENTITY_ID }];
  }
  if (table === chatThreads && thread !== null) {
    return [thread];
  }
  return [];
};

const createSuggestionTx = ({
  thread,
  onInsert,
}: {
  thread: OriginThreadRow | null;
  onInsert: (rows: unknown) => void;
}) => ({
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => rowsForTable(table, thread),
        for: async () => rowsForTable(table, thread),
      }),
    }),
  }),
  insert: () => ({
    values: async (rows: unknown) => {
      onInsert(rows);
    },
  }),
});

describe("DOCX suggestion creation", () => {
  test("records the origin thread's contributing matters on every row", async () => {
    let inserted: unknown = null;
    const { safeDb } = createScopedDbMock(
      createSuggestionTx({
        thread: {
          workspaceId: WORKSPACE_ID,
          dataWorkspaceIds: [CONTRIBUTING_WORKSPACE_ID],
        },
        onInsert: (rows) => {
          inserted = rows;
        },
      }),
    );
    const context = asTestRaw<CreateDocxSuggestionsContext>({
      body: {
        originThreadId: THREAD_ID,
        suggestions: [
          {
            ref: "ref-1",
            opPayload: {
              id: "suggestion-1",
              type: "replaceInBlock",
              blockId: "block-1",
              find: "before",
              replace: "after",
            },
            severity: "medium",
            area: "clause",
          },
        ],
      },
      memberRole: { role: "owner" },
      params: { workspaceId: WORKSPACE_ID, entityId: ENTITY_ID },
      safeDb,
      workspaceId: WORKSPACE_ID,
    });

    expect(await createDocxSuggestions.handler(context)).toEqual({
      items: [{ ref: "ref-1", id: expect.any(String) }],
    });
    expect(inserted).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        entityId: ENTITY_ID,
        originThreadId: THREAD_ID,
        sourceDataWorkspaceIds: [CONTRIBUTING_WORKSPACE_ID],
      }),
    ]);
  });

  test("records no contributing matters when there is no origin thread", async () => {
    let inserted: unknown = null;
    const { safeDb } = createScopedDbMock(
      createSuggestionTx({
        thread: null,
        onInsert: (rows) => {
          inserted = rows;
        },
      }),
    );
    const context = asTestRaw<CreateDocxSuggestionsContext>({
      body: {
        suggestions: [
          {
            ref: "ref-1",
            opPayload: {
              id: "suggestion-1",
              type: "replaceInBlock",
              blockId: "block-1",
              find: "before",
              replace: "after",
            },
            severity: "medium",
            area: "clause",
          },
        ],
      },
      memberRole: { role: "owner" },
      params: { workspaceId: WORKSPACE_ID, entityId: ENTITY_ID },
      safeDb,
      workspaceId: WORKSPACE_ID,
    });

    expect(await createDocxSuggestions.handler(context)).toEqual({
      items: [{ ref: "ref-1", id: expect.any(String) }],
    });
    expect(inserted).toEqual([
      expect.objectContaining({
        originThreadId: null,
        sourceDataWorkspaceIds: [],
      }),
    ]);
  });
});

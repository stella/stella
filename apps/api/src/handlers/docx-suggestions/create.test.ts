import { describe, expect, test } from "bun:test";

import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import { validateDocxSuggestionOperations } from "@/api/handlers/docx-suggestions/operation-validation";
import { toSafeId } from "@/api/lib/branded-types";
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

describe("DOCX suggestion operation validation", () => {
  test("returns folio's validated operation output, not the untrusted input object", () => {
    const inputOperation = {
      id: "suggestion-1",
      type: "replaceInBlock" as const,
      blockId: "block-1",
      find: "before",
      replace: "after",
    };
    const operations = validateDocxSuggestionOperations([inputOperation]);

    expect(operations).toEqual([inputOperation]);
    expect(operations?.at(0)).not.toBe(inputOperation);
  });

  test("rejects malformed operations before persistence", () => {
    expect(
      validateDocxSuggestionOperations([
        {
          id: "suggestion-1",
          type: "replaceInBlock",
          blockId: "block-1",
          find: null,
          replace: "after",
        },
      ]),
    ).toBeUndefined();
  });
});

describe("DOCX suggestion creation", () => {
  test("records the origin thread's contributing matters on every row", async () => {
    let inserted: unknown = null;
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                workspaceId: WORKSPACE_ID,
                dataWorkspaceIds: [CONTRIBUTING_WORKSPACE_ID],
              },
            ],
          }),
        }),
      }),
      insert: () => ({
        values: async (rows: unknown) => {
          inserted = rows;
        },
      }),
    });
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
    const { safeDb } = createScopedDbMock({
      insert: () => ({
        values: async (rows: unknown) => {
          inserted = rows;
        },
      }),
    });
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

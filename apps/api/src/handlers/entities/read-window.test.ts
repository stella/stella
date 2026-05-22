import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import readEntities from "./read";
import readKanbanGroup from "./read-kanban-group";
import readEntitiesWindow from "./read-window";
import { encodeEntitiesWindowCursor } from "./window-cursor";

const workspaceId = toSafeId<"workspace">("ws_entity_window");
const organizationId = toSafeId<"organization">("org_entity_window");
const userId = toSafeId<"user">("user_entity_window");
const createdAt = new Date("2026-01-01T00:00:00.000Z");

const idRows = [
  { id: "doc_1", cursorValues: ["2026-01-01T00:00:00.000Z", "doc_1"] },
  { id: "doc_2", cursorValues: ["2026-01-01T00:00:00.000Z", "doc_2"] },
  { id: "doc_3", cursorValues: ["2026-01-01T00:00:00.000Z", "doc_3"] },
];
const entityRows = idRows.map(({ id }, index) => ({
  id,
  kind: "document" as const,
  name: `Document ${index + 1}`,
  parentId: null,
  currentVersionId: `version_${index + 1}`,
  createdAt,
  updatedAt: createdAt,
  createdByName: "Ada Lovelace",
  createdByImage: null,
  lastEditedByName: null,
  lastEditedByImage: null,
  status: null,
  priority: null,
  dueDate: null,
  sortOrder: null,
}));

const versionCounts = idRows.map(({ id }) => ({
  entityId: id,
  versionCount: 1,
}));
const fileFields = [
  {
    entityVersionId: "version_1",
    id: "field_file_1",
    propertyId: "prop_file",
    content: {
      version: 1 as const,
      type: "file" as const,
      id: "00000000-0000-0000-0000-000000000001",
      fileName: "Document 1.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      encrypted: false,
      sha256Hex:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pdfFileId: null,
    },
  },
];

type ReadWindowCtx = Parameters<typeof readEntitiesWindow.handler>[0];

const createContext = ({
  body,
  safeDb,
}: {
  body:
    | ReadWindowCtx["body"]
    | Parameters<typeof readKanbanGroup.handler>[0]["body"]
    | Parameters<typeof readEntities.handler>[0]["body"];
  safeDb: ReadWindowCtx["safeDb"];
}): ReadWindowCtx =>
  asTestRaw<ReadWindowCtx>({
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body,
    safeDb,
    request: new Request("https://example.test/v1/entities/query-window"),
    route: "/v1/entities/:workspaceId/query-window",
  });

const createSafeDb = ({
  includeCount,
}: {
  includeCount: boolean;
}): Parameters<typeof readEntitiesWindow.handler>[0]["safeDb"] => {
  // queryEntities starts the optional count query before the id query,
  // then starts the phase-2 entity/version/field/session queries together.
  // Keep this queue in that call order so the handler tests fail loudly
  // if the query pipeline changes.
  const results: unknown[] = [
    ...(includeCount ? [[{ total: idRows.length }]] : []),
    idRows,
    entityRows,
    versionCounts,
    fileFields,
    [],
  ];

  return async <T>() => {
    const result = results.shift() ?? [];
    return Result.ok(asTestRaw<T>(result));
  };
};

describe("entity read handlers", () => {
  test("window query unwraps the shared entity query result before reading rows", async () => {
    const result = await readEntitiesWindow.handler(
      createContext({
        body: {
          limit: 2,
          filters: [],
          sorts: [],
          fieldMode: "visible",
          fieldIds: [],
          excludedKinds: ["folder", "task"],
        },
        safeDb: createSafeDb({ includeCount: false }),
      }),
    );

    expect("items" in result).toBe(true);
    if (!("items" in result)) {
      return;
    }

    expect(result.items).toHaveLength(2);
    expect(result.items.at(0)?.fields).toEqual([
      expect.objectContaining({
        propertyId: "prop_file",
        content: expect.objectContaining({
          type: "file",
          mimeType: "application/pdf",
        }),
      }),
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  test("page query unwraps the shared entity query result before building pagination", async () => {
    const result = await readEntities.handler(
      asTestRaw<Parameters<typeof readEntities.handler>[0]>(
        createContext({
          body: {
            page: 1,
            pageSize: 2,
            filters: [],
            sorts: [],
            fieldMode: "visible",
            fieldIds: [],
          },
          safeDb: createSafeDb({ includeCount: true }),
        }),
      ),
    );

    expect("entities" in result).toBe(true);
    if (!("entities" in result)) {
      return;
    }

    expect(result.entities).toHaveLength(2);
    expect(result.totalCount).toBe(3);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  test("kanban group query paginates one group window", async () => {
    const result = await readKanbanGroup.handler(
      asTestRaw<Parameters<typeof readKanbanGroup.handler>[0]>(
        createContext({
          body: {
            limit: 2,
            filters: [],
            sorts: [],
            fieldMode: "visible",
            fieldIds: [],
            groupByPropertyId: "_status",
            groupValue: "open",
          },
          safeDb: createSafeDb({ includeCount: false }),
        }),
      ),
    );

    expect("items" in result).toBe(true);
    if (!("items" in result)) {
      return;
    }

    expect(result.items).toHaveLength(2);
    expect(result.limit).toBe(2);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  test("window query rejects malformed date cursor values before querying", async () => {
    const safeDb: Parameters<
      typeof readEntitiesWindow.handler
    >[0]["safeDb"] = async () => {
      throw new Error("safeDb should not be called");
    };

    const result = await readEntitiesWindow.handler(
      createContext({
        body: {
          limit: 2,
          filters: [],
          sorts: [{ propertyId: "_due-date", desc: false }],
          cursor: encodeEntitiesWindowCursor(["2026-99-99", "doc_1"]),
          fieldMode: "visible",
          fieldIds: [],
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid cursor" },
    });
  });

  test("window query rejects malformed timestamp cursor values before querying", async () => {
    const safeDb: Parameters<
      typeof readEntitiesWindow.handler
    >[0]["safeDb"] = async () => {
      throw new Error("safeDb should not be called");
    };

    const result = await readEntitiesWindow.handler(
      createContext({
        body: {
          limit: 2,
          filters: [],
          sorts: [],
          cursor: encodeEntitiesWindowCursor([
            "2026-13-40T25:61:61.999999",
            "doc_1",
          ]),
          fieldMode: "visible",
          fieldIds: [],
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid cursor" },
    });
  });
});

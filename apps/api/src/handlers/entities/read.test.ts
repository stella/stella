import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createReadFilesystemTreeHandler } from "@/api/handlers/entities/filesystem-tree/get";
import { createReadEntitiesHandler } from "@/api/handlers/entities/list";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const queryEntitiesMock = mock();

const readEntities = createReadEntitiesHandler(queryEntitiesMock);
const readFilesystemTree = createReadFilesystemTreeHandler(queryEntitiesMock);

const workspaceId = toSafeId<"workspace">("ws_entity_read");
const organizationId = toSafeId<"organization">("org_entity_read");
const userId = toSafeId<"user">("user_entity_read");

const createContext = (
  body: Parameters<typeof readEntities.handler>[0]["body"],
): Parameters<typeof readEntities.handler>[0] =>
  asTestRaw<Parameters<typeof readEntities.handler>[0]>({
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: sessionMemberRole("owner"),
    body,
    safeDb: async () => Result.ok([]),
    request: new Request("https://example.test/v1/entities/query"),
    route: "/v1/entities/:workspaceId/query" satisfies ApiRoutePath,
  });

describe("entity read handler search", () => {
  beforeEach(() => {
    queryEntitiesMock.mockReset();
    queryEntitiesMock.mockResolvedValue(
      Result.ok({
        cursorValuesByEntityId: new Map(),
        entities: [],
      }),
    );
  });

  test("hydrates only requested columns by default", async () => {
    await readEntities.handler(createContext({}));
    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ fieldMode: "visible", fieldIds: [] }),
    );
  });

  test("passes bounded search parameters to the shared query", async () => {
    await readEntities.handler(
      createContext({
        filters: [],
        sorts: [],
        limit: 50,
        search: "closing binder",
        fieldMode: "visible",
        fieldIds: [],
      }),
    );

    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { type: "matter", workspaceId },
        currentOrganizationId: organizationId,
        search: "closing binder",
        cursor: null,
        limit: 51,
      }),
    );
  });

  test("passes the AI-previewable sample flag to the shared query", async () => {
    await readEntities.handler(
      createContext({
        filters: [],
        sorts: [],
        limit: 50,
        fieldMode: "visible",
        fieldIds: [],
        previewableForAi: true,
      }),
    );

    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        previewableForAi: true,
        cursor: null,
        limit: 51,
        fieldMode: "visible",
      }),
    );
  });

  test("uses cursor pagination without legacy offset", async () => {
    await readEntities.handler(
      createContext({
        filters: [],
        sorts: [],
        limit: 25,
        fieldMode: "visible",
        fieldIds: [],
      }),
    );

    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: null,
        limit: 26,
      }),
    );
  });

  test("loads a cursor page of the filesystem tree", async () => {
    await readFilesystemTree.handler(
      createContext({
        filters: [],
        sorts: [],
        search: "closing binder",
        fieldMode: "visible",
        fieldIds: [],
      }),
    );

    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { type: "matter", workspaceId },
        currentOrganizationId: organizationId,
        search: "closing binder",
        cursor: null,
        limit: LIMITS.entitiesPageSizeDefault + 1,
        excludedKinds: ["task"],
      }),
    );
  });

  test("filesystem pages keep their row and byte bounds as matter rows grow", async () => {
    const measurements = [];
    for (const rowCount of [10, 200]) {
      const rows = Array.from({ length: rowCount }, (_, index) => ({
        entityId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
        parentId: null,
        name: "Synthetic document ".repeat(10),
      }));
      queryEntitiesMock.mockImplementation(
        async ({ limit }: { limit: number }) =>
          Result.ok({
            entities: rows.slice(0, limit),
            cursorValuesByEntityId: new Map(
              rows.map((row) => [row.entityId, [row.entityId]]),
            ),
          }),
      );
      const response = await readFilesystemTree.handler(
        createContext({ limit: 10 }),
      );
      if (response instanceof HttpStatusResponse) {
        panic("Filesystem page scaling requires a successful response");
      }
      expect(response.items).toHaveLength(10);
      expect(response.limit).toBe(10);
      measurements.push({
        rowCount,
        beforeBytes: Buffer.byteLength(
          JSON.stringify({ entities: rows, ancestorLinks: [] }),
        ),
        bytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.items.length,
      });
    }
    const [small, large] = measurements;
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    if (!small || !large) {
      panic("Scaling fixture must include both cardinalities");
    }
    expect(large.bytes / large.rows).toBeLessThanOrEqual(
      (1.2 * small.bytes) / small.rows,
    );
    console.info("filesystem-page-scaling", JSON.stringify(measurements));
  });
});

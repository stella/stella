import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createReadEntitiesHandler } from "@/api/handlers/entities/read";
import { toSafeId } from "@/api/lib/branded-types";

const queryEntitiesMock = mock();

const readEntities = createReadEntitiesHandler(queryEntitiesMock);

const workspaceId = toSafeId<"workspace">("ws_entity_read");
const organizationId = toSafeId<"organization">("org_entity_read");
const userId = toSafeId<"user">("user_entity_read");

const createContext = (
  body: Parameters<typeof readEntities.handler>[0]["body"],
): Parameters<typeof readEntities.handler>[0] =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields used by the safe handler and read handler
  ({
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body,
    safeDb: async () => Result.ok([]),
    request: new Request("https://example.test/v1/entities/query"),
    route: "/v1/entities/:workspaceId/query",
  }) as unknown as Parameters<typeof readEntities.handler>[0];

describe("entity read handler search", () => {
  beforeEach(() => {
    queryEntitiesMock.mockReset();
    queryEntitiesMock.mockResolvedValue(
      Result.ok({
        entities: [],
        totalCount: 0,
      }),
    );
  });

  test("passes bounded search parameters to the shared query", async () => {
    await readEntities.handler(
      createContext({
        filters: [],
        sorts: [],
        page: 2,
        pageSize: 50,
        search: "closing binder",
        fieldMode: "visible",
        fieldIds: [],
      }),
    );

    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        currentOrganizationId: organizationId,
        search: "closing binder",
        offset: 50,
        limit: 50,
      }),
    );
  });

  test("passes the AI-previewable sample flag to the shared query", async () => {
    await readEntities.handler(
      createContext({
        filters: [],
        sorts: [],
        page: 1,
        pageSize: 50,
        fieldMode: "visible",
        fieldIds: [],
        previewableForAi: true,
      }),
    );

    expect(queryEntitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        previewableForAi: true,
        offset: 0,
        limit: 50,
        fieldMode: "visible",
      }),
    );
  });
});

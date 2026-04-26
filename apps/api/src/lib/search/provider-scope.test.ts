import { beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SearchProvider } from "@/api/lib/search/types";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
} from "@/api/tests/helpers/mock-root-db";

const { paradedbProvider } = await import("@/api/lib/search/paradedb-provider");
const { pgFtsProvider } = await import("@/api/lib/search/pg-fts-provider");

const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("ws_1");

const expectWorkspaceFacetScopedToAuthorizedWorkspace = async (
  provider: SearchProvider,
) => {
  await provider.search({
    query: "closing memo",
    organizationId,
    workspaceId,
    limit: 10,
  });

  expect(rootDbExecuteMock).toHaveBeenCalledTimes(4);
  const workspaceFacetSql = rootDbExecuteMock.mock.calls.at(3)?.[0];
  expect(JSON.stringify(workspaceFacetSql)).toContain(workspaceId);
};

describe("search provider workspace scoping", () => {
  beforeEach(() => {
    clearRootDbMocks();
  });

  test("Postgres FTS workspace facets stay scoped for single-workspace search", async () => {
    await expectWorkspaceFacetScopedToAuthorizedWorkspace(pgFtsProvider);
  });

  test("ParadeDB workspace facets stay scoped for single-workspace search", async () => {
    await expectWorkspaceFacetScopedToAuthorizedWorkspace(paradedbProvider);
  });
});

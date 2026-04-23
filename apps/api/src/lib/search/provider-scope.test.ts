import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SearchProvider } from "@/api/lib/search/types";

const executeMock = mock(async (_query: unknown) => []);

void mock.module("@/api/db/root", () => ({
  db: {
    execute: executeMock,
  },
}));

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

  expect(executeMock).toHaveBeenCalledTimes(4);
  const workspaceFacetSql = executeMock.mock.calls.at(3)?.[0];
  expect(JSON.stringify(workspaceFacetSql)).toContain(workspaceId);
};

describe("search provider workspace scoping", () => {
  beforeEach(() => {
    executeMock.mockClear();
  });

  test("Postgres FTS workspace facets stay scoped for single-workspace search", async () => {
    await expectWorkspaceFacetScopedToAuthorizedWorkspace(pgFtsProvider);
  });

  test("ParadeDB workspace facets stay scoped for single-workspace search", async () => {
    await expectWorkspaceFacetScopedToAuthorizedWorkspace(paradedbProvider);
  });
});

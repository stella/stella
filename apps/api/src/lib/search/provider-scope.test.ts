import { beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
} from "@/api/tests/helpers/mock-root-db";

const { pgFtsProvider } = await import("@/api/lib/search/pg-fts-provider");

const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("ws_1");
const workspaceIdB = toSafeId<"workspace">("ws_2");

// Every executed statement is a drizzle `sql` template; JSON.stringify walks its
// query chunks (static SQL) and bound params (the id values), so a serialized
// query contains both the `organization_id`/`workspace_id` predicate text and
// the actual ids bound into it.
const serializedCalls = (): string[] =>
  rootDbExecuteMock.mock.calls.map(([query]) => JSON.stringify(query));

describe("search provider workspace scoping", () => {
  beforeEach(() => {
    clearRootDbMocks();
  });

  // Class guard: `pgFtsProvider.search` runs on the RLS-bypassing root pool, so
  // tenant isolation depends entirely on every statement carrying the org +
  // workspace predicate by hand. This test fails if any current or future
  // query over `search_documents` drops either, catching a cross-tenant leak
  // at CI time instead of in production.
  test("every FTS read query carries the org and workspace-scope predicate (single workspace)", async () => {
    await pgFtsProvider.search({
      query: "closing memo",
      organizationId,
      workspaceId,
      limit: 10,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(4);
    for (const serialized of serializedCalls()) {
      // Org predicate present and bound to the caller's org.
      expect(serialized).toContain("organization_id");
      expect(serialized).toContain(organizationId);
      // Workspace scope present and bound to the authorized workspace.
      expect(serialized).toContain("workspace_id");
      expect(serialized).toContain(workspaceId);
    }
  });

  test("multi-workspace search scopes every query to the accessible allowlist", async () => {
    await pgFtsProvider.search({
      query: "closing memo",
      organizationId,
      workspaceIds: [workspaceId, workspaceIdB],
      limit: 10,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(4);
    for (const serialized of serializedCalls()) {
      expect(serialized).toContain("organization_id");
      expect(serialized).toContain(organizationId);
      // Both allowlisted workspaces are bound into the ANY(...) scope.
      expect(serialized).toContain(workspaceId);
      expect(serialized).toContain(workspaceIdB);
    }
  });

  test("an empty accessible set fails closed (no rows) instead of matching every workspace", async () => {
    await pgFtsProvider.search({
      query: "closing memo",
      organizationId,
      workspaceIds: [],
      limit: 10,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(4);
    for (const serialized of serializedCalls()) {
      // The org predicate still binds, and the workspace filter degrades to a
      // literal `false` so a caller with no accessible workspaces matches
      // nothing rather than every row in the org.
      expect(serialized).toContain("organization_id");
      expect(serialized).toContain("false");
    }
  });

  test("Postgres FTS workspace facets stay scoped for single-workspace search", async () => {
    await pgFtsProvider.search({
      query: "closing memo",
      organizationId,
      workspaceId,
      limit: 10,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(4);
    const workspaceFacetSql = rootDbExecuteMock.mock.calls.at(3)?.[0];
    expect(JSON.stringify(workspaceFacetSql)).toContain(workspaceId);
  });
});

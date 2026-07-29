import { beforeEach, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const semanticUpdatedAt = new Date("2026-04-30T08:00:00.000Z");
const executeMock = mock(async (_query: SQL) => [
  { entityId: toSafeId<"entity">("entity_1") },
]);
const syncWorkspaceSearchActivityMock = mock(async () => undefined);

void mock.module("@/api/db/root", () => ({
  rootDb: {
    execute: executeMock,
    query: {
      entities: {
        findFirst: mock(async () => ({
          currentVersion: { fields: [], id: toSafeId<"entityVersion">("v_1") },
          createdAt: new Date("2026-04-01T08:00:00.000Z"),
          extractedContent: null,
          id: toSafeId<"entity">("entity_1"),
          kind: "document" as const,
          metadata: null,
          name: "Closing memo",
          updatedAt: semanticUpdatedAt,
          workspace: { organizationId: toSafeId<"organization">("org_1") },
          workspaceId: toSafeId<"workspace">("ws_1"),
        })),
      },
    },
  },
}));

void mock.module("@/api/lib/search/index-global", () => ({
  syncWorkspaceSearchActivity: syncWorkspaceSearchActivityMock,
}));

beforeEach(() => {
  executeMock.mockClear();
  syncWorkspaceSearchActivityMock.mockClear();
});

test("persists an entity's semantic updated timestamp when indexing", async () => {
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }

  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.sql).toContain("INSERT INTO search_documents");
  expect(compiled.sql).not.toContain("now()");
  expect(compiled.params).toContain(semanticUpdatedAt);
  expect(syncWorkspaceSearchActivityMock).toHaveBeenCalledTimes(1);
});

test("rejects an out-of-order projection against the authoritative entity", async () => {
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }

  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.sql).toContain("WITH authoritative_source AS MATERIALIZED");
  expect(compiled.sql).toContain("e.current_version_id =");
  expect(compiled.sql).toContain("COALESCE(e.updated_at, e.created_at) =");
  expect(compiled.sql).toContain("FOR UPDATE");
  expect(compiled.sql).toContain(
    "WHERE EXISTS (SELECT 1 FROM authoritative_source)",
  );
});

test("does not advance matter activity when a stale projection is rejected", async () => {
  executeMock.mockResolvedValueOnce([]);
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(syncWorkspaceSearchActivityMock).not.toHaveBeenCalled();
});

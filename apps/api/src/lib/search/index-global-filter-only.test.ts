import { beforeEach, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
  rootDbTestDouble,
} from "@/api/tests/helpers/mock-root-db";

const { searchGlobal: searchGlobalWithDatabase } =
  await import("@/api/lib/search/index-global");
const searchGlobal = async (
  query: Parameters<typeof searchGlobalWithDatabase>[0],
) => await searchGlobalWithDatabase(query, rootDbTestDouble);

beforeEach(() => {
  clearRootDbMocks();
});

test("filter-only global search skips full-text matching and projections", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["document"],
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const searchDocumentQueries = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query).sql)
    .filter((query) => query.includes("FROM search_documents"));
  const caseLawQueries = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query).sql)
    .filter((query) => query.includes("FROM case_law_search_documents"));

  expect(searchDocumentQueries.length).toBeGreaterThan(0);
  expect(caseLawQueries).toHaveLength(0);
  for (const query of searchDocumentQueries) {
    expect(query).not.toContain("@@");
    expect(query).not.toContain("ts_headline");
    expect(query).not.toContain("ts_rank");
  }

  const hitQuery = searchDocumentQueries.find((query) =>
    query.includes("sd.entity_id AS id"),
  );
  const typeFacetQuery = searchDocumentQueries.find((query) =>
    query.includes("GROUP BY sd.kind"),
  );
  expect(hitQuery).toContain("WHERE sd.organization_id =");
  expect(hitQuery).toContain("sd.workspace_id = ANY(");
  expect(hitQuery).toContain("ORDER BY sd.updated_at DESC, sd.entity_id DESC");
  expect(typeFacetQuery).toContain("sd.kind = ANY(");
});

test("skips alternative corpus counts for an upper-bound-only search", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["document"],
    updatedTo: "2026-07-29T23:59:59.999Z",
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const caseLawQueries = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query).sql)
    .filter((query) => query.includes("FROM case_law_search_documents"));

  expect(caseLawQueries).toHaveLength(0);
});

test("caps alternative case-law counts for an old lower bound", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["document"],
    updatedFrom: "1970-01-01T00:00:00.000Z",
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const caseLawQueries = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query))
    .filter(({ sql: query }) =>
      query.includes("FROM case_law_search_documents"),
    );

  expect(caseLawQueries).toHaveLength(1);
  expect(caseLawQueries.at(0)?.sql).toContain("bounded_case_law");
  expect(caseLawQueries.at(0)?.params).toContain(1000);
});

test("normalizes numeric-offset filters to UTC before binding SQL", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["document"],
    updatedFrom: "2026-07-29T12:00:00+02:00",
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const params = rootDbExecuteMock.mock.calls.flatMap(
    ([query]) => dialect.sqlToQuery(query).params,
  );

  expect(params).toContain("2026-07-29T10:00:00.000Z");
  expect(params).not.toContain("2026-07-29T12:00:00+02:00");
});

test("orders filter-only chat hits on the tenant-leading thread key", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["chat"],
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const hitQuery = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query).sql)
    .find(
      (query) =>
        query.includes("FROM chat_thread_search_documents") &&
        query.includes("cst.title"),
    );

  expect(hitQuery).toContain("t.user_id =");
  expect(hitQuery).toContain("t.organization_id =");
  expect(hitQuery).toContain("ORDER BY t.updated_at DESC, t.id DESC");
});

test("uses authoritative decision timestamps for filter-only case law", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["case-law"],
    updatedFrom: "1970-01-01T00:00:00.000Z",
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const caseLawQueries = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query).sql)
    .filter((query) => query.includes("FROM case_law_search_documents clsd"));

  expect(caseLawQueries).toHaveLength(2);
  for (const query of caseLawQueries) {
    expect(query).toContain(
      "JOIN case_law_decisions d ON d.id = clsd.decision_id",
    );
    expect(query).toContain("d.updated_at >=");
    expect(query).not.toContain("clsd.updated_at >=");
  }

  const hitQuery = caseLawQueries.find((query) =>
    query.includes("clsd.decision_id AS id"),
  );
  const countQuery = caseLawQueries.find((query) =>
    query.includes("bounded_case_law"),
  );
  expect(hitQuery).toContain("d.updated_at");
  expect(hitQuery).toContain(
    "ORDER BY d.updated_at DESC, clsd.decision_id DESC",
  );
  expect(countQuery).toContain("LIMIT");
});

test("caps corpus-wide case-law counts at the pagination horizon", async () => {
  await searchGlobal({
    accessibleWorkspaceIds: [],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["case-law"],
    userId: toSafeId<"user">("user_1"),
  });

  const dialect = new PgDialect();
  const boundedCountQuery = rootDbExecuteMock.mock.calls
    .map(([query]) => dialect.sqlToQuery(query))
    .find(({ sql: query }) => query.includes("bounded_case_law"));

  expect(boundedCountQuery?.sql).toContain("LIMIT");
  expect(boundedCountQuery?.params).toContain(1000);
});

test("sorts filter-only hits newest first across result types", async () => {
  const dialect = new PgDialect();
  rootDbExecuteMock.mockImplementation(async (query: SQL) => {
    const queryText = dialect.sqlToQuery(query).sql;
    if (
      queryText.includes("FROM search_documents") &&
      queryText.includes("sd.entity_id AS id")
    ) {
      return [
        {
          headline: null,
          id: "entity_1",
          last_edited_by_image: null,
          last_edited_by_name: null,
          mime_type: null,
          score: 0,
          title: "Older document",
          type: "document",
          updated_at: new Date("2026-04-01T08:00:00.000Z"),
          workspace_id: "ws_1",
          workspace_name: "Matter",
        },
      ];
    }
    if (
      queryText.includes("FROM workspace_search_documents") &&
      queryText.includes("wsd.workspace_id AS id")
    ) {
      return [
        {
          color: null,
          headline: null,
          id: "ws_1",
          score: 0,
          title: "Newest matter",
          updated_at: new Date("2026-04-02T08:00:00.000Z"),
        },
      ];
    }
    return [];
  });

  const result = await searchGlobal({
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    editedByUserIds: [],
    limit: 10,
    mimeTypes: [],
    organizationId: toSafeId<"organization">("org_1"),
    query: "",
    selectedWorkspaceIds: [],
    types: ["document", "matter"],
    userId: toSafeId<"user">("user_1"),
  });

  expect(result.hits.map(({ title }) => title)).toEqual([
    "Newest matter",
    "Older document",
  ]);
});

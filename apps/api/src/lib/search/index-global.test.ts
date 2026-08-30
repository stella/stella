import { beforeEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";

import { toSafeId } from "@/api/lib/branded-types";
import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import { contactWorkspaceAccessSql } from "@/api/lib/search/contact-workspace-access-sql";
import { encodeCursor } from "@/api/lib/search/cursor";
import { mapEntityHit } from "@/api/lib/search/global-search-mappers";
import { searchGlobal as searchGlobalWithDatabase } from "@/api/lib/search/index-global";
import {
  decodeGlobalSearchCursor,
  encodeGlobalSearchCursor,
} from "@/api/lib/search/pagination";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
  rootDbTestDouble,
} from "@/api/tests/helpers/mock-root-db";

const searchGlobal = async (
  query: Parameters<typeof searchGlobalWithDatabase>[0],
) => await searchGlobalWithDatabase(query, rootDbTestDouble);

process.env["S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["S3_BUCKET"] ??= "test";
process.env["S3_REGION"] ??= "us-east-1";

const entityResourceName = (entityId: string) =>
  toResourceName(
    resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">(entityId),
    }),
  );

describe("global search SQL scope", () => {
  beforeEach(() => {
    clearRootDbMocks();
  });

  test("always constrains contact search to accessible workspaces", async () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      contactWorkspaceAccessSql({
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [],
      }),
    );

    expect(compiled.sql).toContain("w.id = ANY");
    expect(compiled.sql).toContain("w.organization_id");
    expect(compiled.params).toEqual(["ws_1", "ws_2", "org_1"]);
  });

  test("intersects the user's selection with the accessible allowlist", async () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      contactWorkspaceAccessSql({
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      }),
    );

    expect(compiled.sql).toContain("w.id = ANY");
    expect(compiled.params).toEqual(["ws_1", "org_1"]);
  });

  test("scopes chat search to the calling user, org, and data workspaces", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      chatThreadScopeSql({
        userId: toSafeId<"user">("user_1"),
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [],
      }),
    );

    // The user filter is the privacy boundary: chat threads are
    // per-user, and searchGlobal runs on the RLS-bypassing root
    // connection, so a missing user_id predicate would leak other
    // users' conversations.
    expect(compiled.sql).toContain("t.user_id =");
    expect(compiled.sql).toContain("t.organization_id =");
    // A workspace-scoped thread must live in an accessible workspace,
    // and every embedded data workspace must stay within reach.
    expect(compiled.sql).toContain("t.workspace_id IS NULL");
    expect(compiled.sql).toContain("data_workspace_ids <@");
    // Two accessible-workspace arrays (workspace scope + data scope),
    // no selection clause: six params total.
    expect(compiled.params).toEqual([
      "user_1",
      "org_1",
      "ws_1",
      "ws_2",
      "ws_1",
      "ws_2",
    ]);
  });

  test("narrows chat search to selected thread or data workspaces", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      chatThreadScopeSql({
        userId: toSafeId<"user">("user_1"),
        organizationId: toSafeId<"organization">("org_1"),
        accessibleWorkspaceIds: [
          toSafeId<"workspace">("ws_1"),
          toSafeId<"workspace">("ws_2"),
        ],
        selectedWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      }),
    );

    expect(compiled.sql).toContain("t.workspace_id = ANY");
    expect(compiled.sql).toContain("t.data_workspace_ids &&");
    expect(compiled.params).toEqual([
      "user_1",
      "org_1",
      "ws_1",
      "ws_2",
      "ws_1",
      "ws_2",
      "ws_1",
      "ws_1",
    ]);
  });

  test("rechecks case-law redistribution on every projected read", async () => {
    await searchGlobal({
      query: "proportionality",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [],
      selectedWorkspaceIds: [],
      types: ["case-law"],
      editedByUserIds: [],
      mimeTypes: [],
      limit: 10,
    });

    const dialect = new PgDialect();
    const caseLawReads = rootDbExecuteMock.mock.calls
      .map(([query]) => dialect.sqlToQuery(query).sql)
      .filter((sqlText) => sqlText.includes("case_law_search_documents"));
    expect(caseLawReads.length).toBeGreaterThan(0);
    for (const serialized of caseLawReads) {
      expect(serialized).toContain("case_law_sources");
      expect(serialized).toContain("allowsRedistribution");
      expect(serialized).toContain("d.source_id");
    }
  });

  test("maps the last editor avatar for document hits", () => {
    const { hit } = mapEntityHit({
      id: "entity_1",
      workspace_id: "ws_1",
      workspace_name: "Commercial dispute",
      type: "document",
      title: "Interim injunction memo.pdf",
      last_edited_by_name: "Clara Novak",
      last_edited_by_image: "https://example.test/clara.png",
      file_field_id: "field_1",
      file_property_id: "property_1",
      mime_type: "application/pdf",
      headline: "Interim injunction memo",
      score: 0.9,
      updated_at: new Date("2026-04-30T08:00:00.000Z"),
    });

    expect(hit).toMatchObject({
      type: "document",
      lastEditedByName: "Clara Novak",
      lastEditedByImage: "https://example.test/clara.png",
      fileFieldId: "field_1",
      filePropertyId: "property_1",
    });
  });

  test("applies the score/id cursor and bounded lookahead to every source", async () => {
    const sourceCases = [
      {
        tableSql: "FROM search_documents sd",
        idSql: "'entity:' || sd.entity_id::text",
      },
      {
        tableSql: "FROM workspace_search_documents wsd",
        idSql: "'matter:' || wsd.workspace_id::text",
      },
      {
        tableSql: "FROM contact_search_documents csd",
        idSql: "'contact:' || csd.contact_id::text",
      },
      {
        tableSql: "FROM case_law_search_documents clsd",
        idSql: "'case-law:' || clsd.decision_id::text",
      },
      {
        tableSql: "FROM chat_thread_search_documents cst",
        idSql: "'chat:' || cst.thread_id::text",
      },
    ] as const;
    const dialect = new PgDialect();

    await searchGlobal({
      query: "contract",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      selectedWorkspaceIds: [],
      types: [],
      editedByUserIds: [],
      mimeTypes: [],
      updatedTo: "2026-07-29T08:00:00.000Z",
      cursor: encodeGlobalSearchCursor({
        score: 0.75,
        id: "entity:boundary",
        seen: 3,
      }),
      limit: 3,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(5);
    const compiledQueries = rootDbExecuteMock.mock.calls.map(([query]) =>
      dialect.sqlToQuery(query),
    );
    const sourceQueries = sourceCases.map((source) => {
      const compiled = compiledQueries.find(({ sql }) =>
        sql.includes(source.tableSql),
      );
      if (compiled === undefined) {
        throw new Error(`Missing query for ${source.tableSql}`);
      }
      return { source, compiled };
    });

    for (const { source, compiled } of sourceQueries) {
      expect(compiled.sql).toContain(source.idSql);
      expect(compiled.sql).toContain('COLLATE "C" <');
      expect(compiled.params).toContain(0.75);
      expect(compiled.params.at(-1)).toBe(4);
    }

    const matterQuery = sourceQueries.at(1)?.compiled;
    // One boost parameter is in the selected score; each cursor OR branch
    // repeats that same score expression for the keyset boundary.
    expect(matterQuery?.params.filter((param) => param === 0.15)).toHaveLength(
      3,
    );
    expect(sourceQueries.at(4)?.compiled.sql).toContain(
      "cst.preview_generation =",
    );
    expect(sourceQueries.at(4)?.compiled.params).toContain(
      CHAT_SEARCH_DISPLAY_METADATA_GENERATION,
    );
  });

  test("continues legacy offset cursors during a rolling deployment", async () => {
    const dialect = new PgDialect();

    await searchGlobal({
      query: "contract",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      selectedWorkspaceIds: [],
      types: [],
      editedByUserIds: [],
      mimeTypes: [],
      cursor: encodeCursor(25, "global"),
      limit: 3,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(5);
    for (const [query] of rootDbExecuteMock.mock.calls) {
      const compiled = dialect.sqlToQuery(query);
      expect(compiled.sql).not.toContain('COLLATE "C" <');
      expect(compiled.params.at(-1)).toBe(29);
    }
  });

  test("uses updated time as the keyset value for empty-query search", async () => {
    const cursorValue = Date.parse("2026-07-29T08:00:00.000Z");
    const dialect = new PgDialect();

    await searchGlobal({
      query: "",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      selectedWorkspaceIds: [],
      types: ["document"],
      editedByUserIds: [],
      mimeTypes: [],
      cursor: encodeGlobalSearchCursor({
        score: cursorValue,
        id: "entity:boundary",
        seen: 3,
      }),
      limit: 3,
    });

    expect(rootDbExecuteMock).toHaveBeenCalledTimes(1);
    const query = rootDbExecuteMock.mock.calls.at(0)?.at(0);
    if (query === undefined) {
      throw new Error("Missing empty-query document search query");
    }
    const compiled = dialect.sqlToQuery(query);
    expect(compiled.sql).toContain(
      "extract(epoch from sd.updated_at)::float8 * 1000",
    );
    expect(compiled.sql).not.toContain("sd.tsv @@");
    expect(compiled.params).toContain(cursorValue);
    expect(compiled.params.at(-1)).toBe(4);
  });

  test("preserves the SQL timestamp score in filter-only cursors", async () => {
    const dialect = new PgDialect();
    const preciseScore = Date.parse("2026-07-29T08:00:00.999Z") + 0.5;
    rootDbExecuteMock.mockImplementation(
      async (query): Promise<Record<string, unknown>[]> => {
        const compiled = dialect.sqlToQuery(query);
        if (
          compiled.sql.includes("FROM search_documents sd") &&
          compiled.sql.includes("JOIN workspaces w")
        ) {
          return [
            {
              id: "entity_1",
              workspace_id: "ws_1",
              workspace_name: "Matter",
              type: "document",
              title: "First",
              headline: null,
              score: preciseScore,
              updated_at: new Date("2026-07-29T08:00:00.999Z"),
            },
            {
              id: "entity_2",
              workspace_id: "ws_1",
              workspace_name: "Matter",
              type: "document",
              title: "Second",
              headline: null,
              score: preciseScore - 0.4,
              updated_at: new Date("2026-07-29T08:00:00.999Z"),
            },
          ];
        }
        return [];
      },
    );

    const result = await searchGlobal({
      query: "",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
      selectedWorkspaceIds: [],
      types: ["document"],
      editedByUserIds: [],
      mimeTypes: [],
      limit: 1,
    });

    expect(result.hits.map(({ id }) => id)).toEqual(["entity:entity_1"]);
    expect(result.hits.map(({ resourceName }) => resourceName)).toEqual([
      entityResourceName("entity_1"),
    ]);
    expect(decodeGlobalSearchCursor(result.nextCursor ?? undefined)).toEqual({
      score: preciseScore,
      id: "entity:entity_1",
      seen: 1,
    });
  });
  test("selects the filtered file field and prefers previewable extracted sources", async () => {
    await searchGlobal({
      query: "indemnity",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [],
      selectedWorkspaceIds: [],
      types: ["document"],
      editedByUserIds: [],
      mimeTypes: ["application/pdf"],
      limit: 10,
    });

    const dialect = new PgDialect();
    const entityQueries = rootDbExecuteMock.mock.calls
      .map(([query]) => dialect.sqlToQuery(query))
      .filter(({ sql: sqlText }) => sqlText.includes("file_field.field_id"));

    expect(entityQueries.length).toBeGreaterThan(0);
    for (const compiled of entityQueries) {
      expect(compiled.sql).toContain("FROM extracted_content ec");
      expect(compiled.sql).toContain("ec.source_field_id = f.id");
      expect(compiled.sql).toContain("f.property_id");
      expect(compiled.sql).toContain("files.mime_type = ANY");
      expect(compiled.sql).toContain("array_agg(DISTINCT available.mime_type");
      expect(compiled.sql).toContain("files.is_extracted_source DESC");
      expect(compiled.sql).toContain("files.field_id ASC");
      expect(compiled.params).toContain("application/pdf");
      expect(compiled.params).toContain(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }
    expect(
      entityQueries.some((compiled) =>
        compiled.sql.includes("file_field.property_id AS file_property_id"),
      ),
    ).toBeTrue();
  });
});

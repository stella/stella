import { beforeEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
import {
  buildCaseLawDecisionPreviewQuery,
  buildSearchPreviewQuery,
  readSearchPreview,
} from "@/api/lib/search/preview";
import type { GlobalSearchResultType } from "@/api/lib/search/types";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
  rootDbTestDouble,
} from "@/api/tests/helpers/mock-root-db";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = toSafeId<"organization">(
  "00000000-0000-4000-8000-000000000001",
);
const userId = toSafeId<"user">("user_1");
const accessibleWorkspaceIds = [
  toSafeId<"workspace">("00000000-0000-4000-8000-000000000002"),
  toSafeId<"workspace">("00000000-0000-4000-8000-000000000003"),
];
const resultId = "00000000-0000-4000-8000-000000000004";
const SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT = 50_000;
const SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT = 1000;
const SEARCH_PREVIEW_BODY_CHARACTER_LIMIT = 48_999;
const SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT = 16_000;
const SEARCH_PREVIEW_NORMALIZED_SOURCE_CHARACTER_LIMIT = 100_000;

const compilePreview = (
  type: GlobalSearchResultType,
  query = "closing memo",
) => {
  const dialect = new PgDialect();
  return dialect.sqlToQuery(
    buildSearchPreviewQuery({
      query,
      resultId,
      type,
      organizationId,
      userId,
      accessibleWorkspaceIds,
    }),
  );
};

describe("search preview authorization scope", () => {
  test("bounds selected source and normalization independently of body length", () => {
    const compiled = compilePreview("document");
    expect(compiled.params).toContain(SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT);
    expect(compiled.params).toContain(SEARCH_PREVIEW_BODY_CHARACTER_LIMIT);
    expect(compiled.params).toContain(SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT);
    expect(compiled.params).toContain(
      SEARCH_PREVIEW_NORMALIZED_SOURCE_CHARACTER_LIMIT,
    );
    expect(compiled.sql).not.toContain("generate_series");
    expect(compiled.sql).not.toContain("char_length(sd.searchable_text)");
    expect(compiled.sql).not.toContain("to_tsvector");
    expect(compiled.sql).toContain("LEFT JOIN LATERAL");
    expect(compiled.sql).toContain("search_document_preview_passages passage");
    expect(compiled.sql).toContain("passage.tsv @@");
    expect(compiled.sql).toContain(
      "passage.generation = sd.preview_generation",
    );
    expect(compiled.sql).toContain("VALUES");
    expect(compiled.sql).toContain("|| ' ' ||");
    expect(
      SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT +
        1 +
        SEARCH_PREVIEW_BODY_CHARACTER_LIMIT,
    ).toBe(SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT);
  });

  test("uses persisted bounded passages for every searchable projection", () => {
    const resultTypes = [
      "matter",
      "contact",
      "case-law",
      "document",
      "folder",
      "task",
      "message",
      "link",
    ] as const satisfies readonly GlobalSearchResultType[];

    for (const type of resultTypes) {
      const compiled = compilePreview(type);
      expect(compiled.sql).not.toContain("generate_series");
      expect(compiled.sql).not.toContain("char_length(");
      expect(compiled.sql).not.toContain("to_tsvector");
      expect(compiled.sql).toContain("_preview_passages passage");
      expect(compiled.sql).toContain("passage.tsv @@");
      expect(compiled.sql).toContain("passage.generation =");
      expect(compiled.sql).toContain("passage.ordinal = 0");
    }
  });

  test("matches document passages with the indexed normalization and config", () => {
    const compiled = compilePreview("document");

    expect(compiled.sql).toContain(
      "coalesce(sd.language, 'simple')::regconfig",
    );
    expect(compiled.sql).toContain("unaccent(arabic_normalize(");
    expect(compiled.sql).toContain(
      "unaccent(arabic_normalize(preview_source.content))",
    );
    expect(compiled.sql).toContain(
      "ts_headline(\n            coalesce(sd.language, 'simple')::regconfig,\n            normalized_preview_source.content",
    );
    expect(compiled.sql).toContain("'sourceContent'");
    expect(compiled.sql).toContain(
      "'normalizedSourceContent',\n        normalized_preview_source.content",
    );
    expect(
      compiled.sql.match(
        /unaccent\(arabic_normalize\(preview_source\.content\)\)/gu,
      )?.length,
    ).toBe(1);
    expect(compiled.sql).toMatch(/'useUnaccent',\s+true/u);
    expect(compiled.params).not.toContain(undefined);
    expect(compiled.sql).not.toContain("public.stella_unaccent");
  });

  test("matches simple-config projections with their indexed normalization", () => {
    const projectionTypes = [
      "matter",
      "contact",
    ] as const satisfies readonly GlobalSearchResultType[];

    for (const type of projectionTypes) {
      const compiled = compilePreview(type);
      expect(compiled.sql).toContain("'simple'::regconfig");
      expect(compiled.sql).toContain("unaccent(arabic_normalize(");
    }
  });

  test("returns a bounded unhighlighted excerpt for filter-only searches", () => {
    const compiled = compilePreview("document", "");

    expect(compiled.sql).not.toContain("ts_headline");
    expect(compiled.sql).not.toContain("@@");
    expect(compiled.sql).not.toContain("generate_series");
    expect(compiled.sql).not.toContain("_preview_passages");
    expect(compiled.sql).toContain("'normalizedSourceContent',");
    expect(compiled.sql).toMatch(/'normalizedSourceContent',\s+NULL/u);
    expect(compiled.params).toContain(SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT);
    expect(compiled.params).toContain(SEARCH_PREVIEW_BODY_CHARACTER_LIMIT);
    expect(compiled.params).toContain(SEARCH_PREVIEW_RESPONSE_CHARACTER_LIMIT);
    expect(compiled.sql).toContain("sd.organization_id =");
    expect(compiled.sql).toContain("sd.workspace_id = ANY");
  });

  test("every workspace entity kind is constrained by org and workspace", () => {
    const entityTypes = [
      "document",
      "folder",
      "task",
      "message",
      "link",
    ] as const satisfies readonly GlobalSearchResultType[];

    for (const type of entityTypes) {
      const compiled = compilePreview(type);
      expect(compiled.sql).toContain("FROM search_documents sd");
      expect(compiled.sql).toContain("sd.organization_id =");
      expect(compiled.sql).toContain("sd.workspace_id = ANY");
      expect(compiled.sql).toContain("sd.kind =");
      expect(compiled.params).toContain(organizationId);
      expect(compiled.params).toContain(accessibleWorkspaceIds.at(0));
      expect(compiled.params).toContain(accessibleWorkspaceIds.at(1));
    }
  });

  test("matter preview is constrained by org and workspace", () => {
    const compiled = compilePreview("matter");
    expect(compiled.sql).toContain("FROM workspace_search_documents wsd");
    expect(compiled.sql).toContain("wsd.organization_id =");
    expect(compiled.sql).toContain("wsd.workspace_id = ANY");
    expect(compiled.params).toContain(organizationId);
    expect(compiled.params).toContain(accessibleWorkspaceIds.at(0));
  });

  test("contact preview repeats relationship-based workspace access", () => {
    const compiled = compilePreview("contact");
    expect(compiled.sql).toContain("FROM contact_search_documents csd");
    expect(compiled.sql).toContain("AND EXISTS");
    expect(compiled.sql).toContain("w.id = ANY");
    expect(compiled.sql).toContain("w.organization_id =");
    expect(compiled.params).toContain(organizationId);
    expect(compiled.params).toContain(accessibleWorkspaceIds.at(0));
  });

  test("chat preview is private to its user, org, and workspace set", () => {
    const compiled = compilePreview("chat");
    expect(compiled.sql).toContain("FROM chat_thread_search_documents cst");
    expect(compiled.sql).toContain("FROM chat_message_search_documents");
    expect(compiled.sql).toContain("cst.preview_generation =");
    expect(compiled.params).toContain(CHAT_SEARCH_DISPLAY_METADATA_GENERATION);
    expect(compiled.sql).toContain("JOIN chat_messages message");
    expect(compiled.sql).toContain("ts_rank_cd(matching.tsv");
    expect(compiled.sql).toContain('AS "isTitleOnlyMatch"');
    // The title-only check reads the thread row's title, the same version as
    // its provenance, not the index copy that can lag behind a rename.
    expect(compiled.sql).toContain("arabic_normalize(coalesce(t.title, ''))");
    expect(compiled.sql).not.toContain(
      "arabic_normalize(coalesce(cst.title, ''))",
    );
    expect(compiled.sql).toContain("ORDER BY nearby.created_at");
    expect(compiled.sql).toContain("LIMIT");
    expect(compiled.sql).toContain("t.user_id =");
    expect(compiled.sql).toContain("t.organization_id =");
    expect(compiled.sql).toContain("t.workspace_id IS NULL");
    expect(compiled.sql).toContain("data_workspace_ids <@");
    expect(compiled.params).toContain(userId);
    expect(compiled.params).toContain(organizationId);
  });

  test("anchors advanced chat previews with positive locator terms", () => {
    const compiled = compilePreview(
      "chat",
      "indemnity AND liability NOT superseded",
    );

    expect(compiled.params).toContain("(indemnity:*) | (liability:*)");
    expect(compiled.params).not.toContain("(superseded:*)");
  });

  test("chat filter-only preview returns a bounded recent message window", () => {
    const compiled = compilePreview("chat", "");

    expect(compiled.sql).not.toContain("ts_rank_cd");
    expect(compiled.sql).not.toContain("matching.tsv @@");
    expect(compiled.sql).toContain("latest.created_at DESC");
    expect(compiled.sql).toContain("JOIN chat_messages message");
    expect(compiled.params).toContain(6);
    expect(compiled.params).toContain(0);
  });

  test("case-law preview stays on the intentionally public corpus", () => {
    const compiled = compilePreview("case-law");
    expect(compiled.sql).toContain("FROM case_law_search_documents clsd");
    expect(compiled.sql).toContain(
      "JOIN case_law_published_decisions d ON d.id = clsd.decision_id",
    );
    expect(compiled.sql).toContain(
      "JOIN case_law_sources\n    ON case_law_sources.id = d.source_id",
    );
    expect(compiled.sql).toContain(
      "LEFT JOIN case_law_fts_configs clfc ON clfc.language = clsd.language",
    );
    expect(compiled.sql).toContain("clsd.regconfig::regconfig");
    expect(compiled.sql).toContain("coalesce(clfc.use_unaccent, true)");
    expect(compiled.sql).toContain("unaccent(arabic_normalize(");
    expect(compiled.sql).toContain(
      "unaccent(arabic_normalize(preview_source.content))",
    );
    expect(compiled.sql).toContain("ELSE arabic_normalize(");
    expect(compiled.sql).toContain("allowsRedistribution");
    expect(compiled.sql).not.toContain("organization_id");
    expect(compiled.sql).not.toContain("workspace_id");
    // The hit came from the corpus search engine: the decision is read by id
    // and not asked to match the global tsquery again.
    expect(compiled.sql).not.toContain("clsd.tsv @@");
  });
});

describe("case-law preview without a search projection row", () => {
  // Canonical corpus storage writes no projection row, yet the corpus search
  // engine still returns the decision as a hit.
  const { scopedDb } = createScopedDbMock(rootDbTestDouble);
  const dialect = new PgDialect();
  const query = {
    query: "náhrada škody",
    resultId,
    type: "case-law",
    organizationId,
    userId,
    accessibleWorkspaceIds,
  } as const;
  const decisionRow = {
    id: resultId,
    title: "25 Cdo 1234/2024 - Nejvyšší soud",
    fulltext: null,
    text_s3_key: "case-law/text/abc",
    content_hash: "a".repeat(64),
  };

  beforeEach(() => {
    clearRootDbMocks();
  });

  const answering = (decision: Record<string, unknown> | null) => {
    rootDbExecuteMock.mockImplementation(async (statement) => {
      const text = dialect.sqlToQuery(statement).sql;
      return await Promise.resolve(
        text.includes("case_law_search_documents") || decision === null
          ? []
          : [decision],
      );
    });
  };

  test("reads the decision's stored text and opens on the query's words", async () => {
    answering(decisionRow);
    const reads: unknown[] = [];
    const preview = await readSearchPreview(query, scopedDb, {
      readCaseLawText: async (source) => {
        reads.push(source);
        return await Promise.resolve(
          `${"Úvod. ".repeat(4000)}Žalobce se domáhal náhrady škody za vadné plnění.`,
        );
      },
    });

    expect(reads).toEqual([
      {
        id: resultId,
        fulltext: null,
        textS3Key: "case-law/text/abc",
        contentHash: "a".repeat(64),
      },
    ]);
    const value = preview.unwrap();
    expect(value?.type).toBe("plain-text");
    const content = value?.type === "plain-text" ? value.content : "";
    expect(content.startsWith("25 Cdo 1234/2024 - Nejvyšší soud ")).toBe(true);
    expect(content).toContain("náhrady škody");
  });

  test("shows the title alone when the decision has no text", async () => {
    answering(decisionRow);
    const preview = await readSearchPreview(query, scopedDb, {
      readCaseLawText: async () => await Promise.resolve(null),
    });

    expect(preview.unwrap()).toEqual({
      type: "plain-text",
      content: "25 Cdo 1234/2024 - Nejvyšší soud",
    });
  });

  test("a decision the public may not read has no preview", async () => {
    answering(null);
    const preview = await readSearchPreview(query, scopedDb, {
      readCaseLawText: async () => await Promise.resolve("unused"),
    });

    expect(preview.unwrap()).toBeNull();
  });

  test("the decision read keeps the published and redistributable gate", () => {
    const compiled = dialect.sqlToQuery(
      buildCaseLawDecisionPreviewQuery(resultId),
    );
    expect(compiled.sql).toContain("FROM case_law_published_decisions d");
    expect(compiled.sql).toContain(
      "JOIN case_law_sources\n    ON case_law_sources.id = d.source_id",
    );
    expect(compiled.sql).toContain("allowsRedistribution");
    expect(compiled.params).toContain(resultId);
  });
});

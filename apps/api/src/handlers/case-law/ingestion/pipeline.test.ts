import { Result } from "better-result";
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  DECISION_TEXT_FIELD,
  TEXT_ABSENCE_REASONS,
} from "@stll/api-contract/case-law-text-field";
import {
  DECISION_DOCUMENT_ROLE,
  DECISION_DOCUMENT_ROLE_METADATA_KEY,
} from "@stll/api-contract/decision-document-role";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";
import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObserver,
} from "@stll/legal-atlas/document-fetch-diagnostics";
import {
  CYCLE_HALT_REASON,
  INGESTION_STOP_KIND,
} from "@stll/legal-atlas/ingestion-cycle";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { caseLawIngestionFailures } from "@/api/db/schema";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { plainTextOf } from "@/api/handlers/case-law/document-ast";
import {
  EMPTY_AST,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import {
  bareCitationKey,
  decisionIdentifiersFromStoredMetadata,
  extractCitations,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { wrappedErrorDetail } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSafeId } from "@/api/lib/branded-types";
import { CITATION_STORAGE_WIDTHS } from "@/api/lib/case-law/citation-storage-bounds";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  presentTextField,
  readDecisionTextMetadata,
  splitStoredDecisionTextMetadata,
} from "@/api/lib/case-law/decision-text";
import { CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES } from "@/api/lib/case-law/search-candidate-row-bound-sql";
import { canonicalDecisionDate } from "@/api/lib/dates";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  AdapterFetchError,
  TimeoutError,
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { observePublisherDocumentFetch } from "@/api/lib/legal-search/document-stage-observation";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  fitsDecisionSearchCandidateRow,
  markListingOnly,
  observedDocketOf,
  sanitizeResult,
  partialObservationFromMetadata,
  storedCaseNumberOf,
} from "@/api/lib/legal-search/ingestion-normalization";
import type { ObservedDocket } from "@/api/lib/legal-search/ingestion-normalization";
import { defineSourceAdapter } from "@/api/lib/legal-search/ingestion-types";
import type { RawIngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";

// An insert whose values can be awaited directly or chained into an upsert,
// as the refresh path does for identifier rows.
// oxlint-disable-next-line typescript/promise-function-async -- the double returns a promise that also carries onConflictDoUpdate; `async` would drop the extra method
const insertedValues = () =>
  Object.assign(Promise.resolve(undefined), {
    onConflictDoUpdate: async () => await Promise.resolve(undefined),
  });

const baseResult = (
  documentAst: IngestionResult["documentAst"],
): IngestionResult =>
  plainTextIngestionResult({
    caseNumber: "X/1/2026",
    court: "Test Court",
    country: "SK",
    language: "sk",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "hash",
    documentAst,
  });

const astMetadata = {
  caseNumber: "X/1/2026",
  court: "Test Court",
  ecli: "ECLI:SK:TEST:2026:1.1",
  decisionDate: "2026-01-01",
  decisionType: "uznesenie",
  keywords: [],
  statutes: [],
};

const originalCzNsFetchPage = czNsAdapter.fetchPage;

const testSourceLease = (
  source: typeof caseLawSources.$inferSelect,
): CaseLawSourceIngestionLease => ({
  beforeDatabaseMark: async () => undefined,
  beforeRemoteEffect: async (effect) => await effect(),
  leaseToken: createSafeId<"caseLawSourceIngestionLease">(),
  release: async () => undefined,
  source,
});

const cursorOnlyDb =
  (onCursor: (cursor: string | null | undefined) => void): ScopedDb =>
  async (callback) => {
    const tx = {
      insert: () => ({ values: insertedValues }),
      query: {
        caseLawDecisions: { findFirst: async () => undefined },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            for: () => ({ limit: async () => await Promise.resolve([]) }),
            limit: async () =>
              await Promise.resolve(
                table === caseLawSources
                  ? [{ adapterKey: ADAPTER_KEYS.CZ_NS }]
                  : [],
              ),
          }),
        }),
      }),
      execute: async () => await Promise.resolve([]),
      update: (table: unknown) => ({
        set: (values: { syncCursor?: string | null }) => {
          if (table === caseLawSources && "syncCursor" in values) {
            onCursor(values.syncCursor);
          }

          return {
            where: () => ({
              returning: async () => [
                { cursor: values.syncCursor ?? null, order: 1n },
              ],
            }),
          };
        },
      }),
    };

    // SAFETY: these cases exercise only the case_law_sources cursor update;
    // the fake implements that chain.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return await callback(tx as unknown as Transaction);
  };

afterEach(() => {
  czNsAdapter.fetchPage = originalCzNsFetchPage;
});

describe("publisher document role persistence", () => {
  test.each(Object.values(DECISION_DOCUMENT_ROLE))(
    "projects the typed %s role and converges without changing stated types",
    (documentRole) => {
      const input = {
        ...baseResult(EMPTY_AST),
        documentRole,
        decisionType: "uzasadnienie bez sentencji",
        metadata: {
          [DECISION_DOCUMENT_ROLE_METADATA_KEY]: "untrusted",
          decisionType: "uzasadnienie bez sentencji",
          publisherField: "REASONS",
        },
      };
      const stored = sanitizeResult(input);
      expect(
        stored.metadata[DECISION_DOCUMENT_ROLE_METADATA_KEY] === documentRole,
      ).toBe(true);
      expect(stored.documentRole).toBe(documentRole);
      expect(stored.decisionType === input.decisionType).toBe(true);
      expect(
        stored.metadata["decisionType"] === input.metadata.decisionType,
      ).toBe(true);
      expect(input.metadata[DECISION_DOCUMENT_ROLE_METADATA_KEY]).toBe(
        "untrusted",
      );
      expect(
        sanitizeResult({
          ...stored,
          ...splitStoredDecisionTextMetadata(stored.metadata),
        }),
      ).toEqual(stored);
    },
  );

  test("omission is unknown even when raw metadata or localized type claims a role", () => {
    const input = {
      ...baseResult(EMPTY_AST),
      decisionType: "uzasadnienie",
      metadata: {
        [DECISION_DOCUMENT_ROLE_METADATA_KEY]: DECISION_DOCUMENT_ROLE.RULING,
      },
    };
    const stored = sanitizeResult(input);
    expect(stored.documentRole).toBeUndefined();
    expect(
      Object.hasOwn(stored.metadata, DECISION_DOCUMENT_ROLE_METADATA_KEY),
    ).toBe(false);
    expect(stored.decisionType === input.decisionType).toBe(true);
    expect(
      sanitizeResult({
        ...stored,
        ...splitStoredDecisionTextMetadata(stored.metadata),
      }),
    ).toEqual(stored);
  });
});

describe("sanitizeResult — decision text fields", () => {
  test("stores present text and retains the boundary value", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        summary: presentTextField("Published summary"),
      },
    });

    expect(sanitized.metadata["summary"] === "Published summary").toBe(true);
    expect(
      Bun.deepEquals(
        sanitized.textFields.summary,
        presentTextField("Published summary"),
      ),
    ).toBe(true);
  });

  test("keeps text keys nullable while retaining every declared absence", () => {
    for (const reason of TEXT_ABSENCE_REASONS) {
      const sanitized = sanitizeResult({
        ...baseResult(EMPTY_AST),
        textFields: {
          ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
          summary: absentTextField(reason),
        },
      });

      expect(sanitized.metadata["summary"]).toBeUndefined();
      expect(
        readDecisionTextMetadata(sanitized.metadata).textFields.summary,
      ).toEqual(absentTextField(reason));
    }
  });
});

describe("sanitizeResult — adapter-supplied sections", () => {
  test("strips control characters the way every other field is stripped", () => {
    // Sections arrive from court HTML like `fulltext` and `documentAst`
    // do. The wording-based fallback was safe only because
    // `segmentDecision` runs on already-sanitized `fulltext`; a parser
    // that supplies its own sections bypasses that.
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sections: [
        {
          index: 0,
          type: "ruling",
          title: "Vy\u0000rok",
          text: "Text\u0000with\u200Bcontrol\uFEFFchars.",
        },
      ],
    });

    expect(sanitized.sections?.at(0)?.title).toBe("Vyrok");
    expect(sanitized.sections?.at(0)?.text).toBe("Textwithcontrolchars.");
  });

  test("leaves a section without a title as null", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sections: [{ index: 0, type: "ruling", title: null, text: "Text." }],
    });

    expect(sanitized.sections?.at(0)?.title).toBeNull();
  });
});

describe("sanitizeResult — decision identifiers", () => {
  test("persists the complete source identifier set for exact replay", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          value: "12 Test Reporter 34",
        },
      ],
    });

    expect(
      decisionIdentifiersFromStoredMetadata({
        caseNumber: sanitized.caseNumber,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        ecli: sanitized.ecli ?? null,
        jurisdiction: sanitized.country,
        metadata: sanitized.metadata,
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "X/1/2026",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "12 Test Reporter 34",
      },
    ]);
  });
});

describe("sanitizeResult — docket grammar", () => {
  const observed = (country: string, caseNumber: string): IngestionResult =>
    plainTextIngestionResult({
      ...baseResult(EMPTY_AST),
      country,
      caseNumber,
      sourceDocumentId: "publisher-document",
      metadata: { caseNumber },
    });

  test.each([
    ["CZE", "33 Cdo 1751/2023- II.", "33 Cdo 1751/2023"],
    ["SVK", "5Obo/12/2020 - IV.", "5Obo/12/2020"],
    ["POL", "I ACa 123/20.", "I ACa 123/20"],
    ["HUN", "Pfv.IV.20.123/2020/5 -", "Pfv.IV.20.123/2020/5"],
  ])("%s: %s is stored as %s", (country, raw, caseNumber) => {
    const input = observed(country, raw);
    expect(observedDocketOf(input)).toEqual({
      type: "trimmed",
      caseNumber,
      removed: raw.slice(raw.indexOf(caseNumber) + caseNumber.length),
    });
    const sanitized = sanitizeResult(input);
    expect(sanitized.caseNumber === caseNumber).toBe(true);
    expect(sanitized.metadata["caseNumber"] === raw).toBe(true);
  });

  test.each([
    ["a trimmed sheet", "33 Cdo 1751/2023- II."],
    ["a control character", "33 Cdo​ 1751/2023"],
    ["a docket as written", "33 Cdo 1751/2023"],
  ])("the stored reference of %s is the one the write stores", (_, raw) => {
    const input = observed("CZE", raw);
    expect(storedCaseNumberOf(input)).toBe(sanitizeResult(input).caseNumber);
  });

  test("a docket keyed row keeps its tail and is reported unkeyed", () => {
    const input = plainTextIngestionResult({
      ...observed("CZE", "33 Cdo 1751/2023- II."),
      sourceDocumentId: undefined,
    });
    expect(observedDocketOf(input)).toEqual({
      type: "unkeyed",
      caseNumber: "33 Cdo 1751/2023",
      removed: "- II.",
    });
    expect(sanitizeResult(input).caseNumber === "33 Cdo 1751/2023- II.").toBe(
      true,
    );
  });

  test.each<[string, string, ObservedDocket["type"]]>([
    ["CZE", "21 Cdo 1234/2020-5", "kept"],
    ["HUN", "5.P.21.203/2004.", "kept"],
    ["CZE", "33 Cdo 1751/2023 civil", "unparsed"],
    ["XXX", "1 A 2/2020 - II.", "kept"],
  ])("%s: %s is stored as written (%s)", (country, raw, type) => {
    const input = observed(country, raw);
    expect(observedDocketOf(input).type).toBe(type);
    expect(sanitizeResult(input).caseNumber === raw).toBe(true);
  });

  test("a placeholder docket is never read against the grammar", () => {
    expect(
      observedDocketOf(
        plainTextIngestionResult({
          ...observed("CZE", "NALUS record 7301"),
          caseNumberIsPlaceholder: true,
        }),
      ),
    ).toEqual({ type: "kept" });
  });

  test("a primary reference other than a docket is never read against the grammar", () => {
    const input = plainTextIngestionResult({
      ...observed("USA", "347 U.S. 483."),
      caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    });
    expect(observedDocketOf(input)).toEqual({ type: "kept" });
    expect(sanitizeResult(input).caseNumber === "347 U.S. 483.").toBe(true);
  });
});

describe("sanitizeResult — decision date bounds", () => {
  // Adapters normalize dates differently or not at all, and the column
  // takes an impossible year as readily as a real one. A document whose
  // date is unusable is still worth storing, so the date drops and the
  // row survives.
  test("drops a year outside the range a decision can carry", () => {
    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2944-04-30",
      }).decisionDate,
    ).toBeUndefined();

    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "0001-01-01",
      }).decisionDate,
    ).toBeUndefined();
  });

  test("drops a day that does not exist on the calendar", () => {
    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2026-02-30",
      }).decisionDate,
    ).toBeUndefined();
  });

  test("keeps a date the sources actually publish", () => {
    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2026-04-15",
      }).decisionDate,
    ).toBe("2026-04-15");

    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2026-04-15T00:00:00Z",
      }).decisionDate,
    ).toBe("2026-04-15");
  });

  test("leaves an absent date absent", () => {
    expect(sanitizeResult(baseResult(EMPTY_AST)).decisionDate).toBeUndefined();
  });
});

describe("sanitizeResult — shared partial-observation quality", () => {
  test("secondary refusal retains document detail until a write proves no document exists", () => {
    const refused = sanitizeResult({
      ...baseResult(EMPTY_AST),
      observationDetail: "secondary-refused",
    });
    expect(partialObservationFromMetadata(refused.metadata)).toEqual({
      caseNumberIsPlaceholder: false,
      detail: "secondary-refused",
    });
    expect(
      partialObservationFromMetadata(markListingOnly(refused.metadata)),
    ).toEqual({
      caseNumberIsPlaceholder: false,
      detail: "listing-only",
    });
  });

  test("persists adapter-neutral quality and removes it after detail recovery", () => {
    const partial = sanitizeResult({
      ...baseResult(EMPTY_AST),
      caseNumberIsPlaceholder: true,
      isListingOnly: true,
    });
    expect(partialObservationFromMetadata(partial.metadata)).toEqual({
      caseNumberIsPlaceholder: true,
      detail: "listing-only",
    });

    const recovered = sanitizeResult({
      ...partial,
      ...splitStoredDecisionTextMetadata(partial.metadata),
      caseNumberIsPlaceholder: undefined,
      isListingOnly: undefined,
      observationDetail: "complete",
    });
    expect(partialObservationFromMetadata(recovered.metadata)).toEqual({
      caseNumberIsPlaceholder: false,
      detail: "complete",
    });
  });
});

describe("sanitizeResult — shared publisher identity limits", () => {
  test("drops an oversized alias without poisoning a valid canonical id", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sourceDocumentId: "publisher:canonical",
      sourceDocumentIdAliases: [
        "publisher:fallback",
        "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      ],
      sourceDocumentIdRepairAliases: [
        "publisher:repair",
        "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      ],
    });

    expect(sanitized.sourceDocumentIdAliases).toEqual(["publisher:fallback"]);
    expect(sanitized.sourceDocumentIdRepairAliases).toEqual([
      "publisher:repair",
    ]);
  });

  test("rejects an oversized canonical id instead of truncating identity", () => {
    expect(() =>
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        sourceDocumentId: "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      }),
    ).toThrow("Publisher document identity exceeds storage limits");
  });

  test("drops aliases changed by sanitization instead of merging identities", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sourceDocumentId: "publisher:canonical",
      sourceDocumentIdAliases: ["publisher:a\u200Bb", "publisher:ab"],
      sourceDocumentIdRepairAliases: [
        "publisher:repair\u200Bchanged",
        "publisher:repair-clean",
      ],
    });

    expect(sanitized.sourceDocumentIdAliases).toEqual(["publisher:ab"]);
    expect(sanitized.sourceDocumentIdRepairAliases).toEqual([
      "publisher:repair-clean",
    ]);
  });

  test("rejects a canonical id changed by sanitization", () => {
    expect(() =>
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        sourceDocumentId: "publisher:a\u200Bb",
      }),
    ).toThrow("Publisher document identity cannot be sanitized");
  });

  // The reconciliation engine parks a failed item under `errorTag(error)`, so
  // the refusal's class is the whole operator-visible record of why a slice
  // stopped short. A bare `TypeError` there names a JavaScript operation and
  // is indistinguishable from a helper dereferencing undefined; these say
  // which field of the publisher's row the corpus would not take.
  test.each([
    [
      UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER,
      {
        identifiers: [
          { type: "case-number", value: "x".repeat(300) },
        ] as const satisfies DecisionIdentifiers,
      },
    ],
    [
      UNPERSISTABLE_DECISION_FIELDS.SOURCE_DOCUMENT_ID,
      { sourceDocumentId: "publisher:a\u200Bb" },
    ],
  ])("parks as an unpersistable %s, not a TypeError", (field, overrides) => {
    const thrown = ((): unknown => {
      try {
        sanitizeResult({ ...baseResult(EMPTY_AST), ...overrides });
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(UnpersistableDecisionFieldError);
    expect(errorTag(thrown)).toBe("UnpersistableDecisionFieldError");
    expect(
      thrown instanceof UnpersistableDecisionFieldError
        ? thrown.field
        : undefined,
    ).toBe(field);
  });
});

describe("sanitizeResult — documentAst text fields", () => {
  // plainText fields feed the DB full-text search index, so we
  // collapse spaced-letter emphasis ("r o z h o d o l" → "rozhodol")
  // there. Inline text is the court's verbatim rendering, and must
  // not be touched by the sanitizer so the reader shows the document
  // exactly as the court set it.
  test("plainText is collapsed, inline text stays verbatim", () => {
    const ast: DocumentAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "x",
        webUrl: "",
        printUrl: "",
      },
      metadata: astMetadata,
      blocks: [
        {
          id: "b1",
          anchorId: "h-holding",
          type: "heading",
          level: 2,
          role: "section-heading",
          inlines: [
            {
              type: "bold",
              children: [{ type: "text", text: "r o z h o d o l :" }],
            },
          ],
          plainText: "r o z h o d o l :",
        },
        {
          id: "b2",
          anchorId: "p1",
          type: "paragraph",
          inlines: [
            {
              type: "text",
              text: "Podľa § 193 ods.1 z a m i e t a obžalobu.",
            },
          ],
          plainText: "Podľa § 193 ods.1 z a m i e t a obžalobu.",
        },
        {
          id: "b3",
          anchorId: "p2",
          type: "paragraph",
          inlines: [{ type: "text", text: "Normálny text bez medzier." }],
          plainText: "Normálny text bez medzier.",
        },
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }

    const [holding, holdingPara, plainPara] = sanitized.documentAst.blocks;
    if (
      holding?.type !== "heading" ||
      holdingPara?.type !== "paragraph" ||
      plainPara?.type !== "paragraph"
    ) {
      throw new Error("unexpected block types after sanitize");
    }

    // plainText is collapsed in-place.
    expect(holding.plainText).toBe("rozhodol:");
    expect(holdingPara.plainText).toBe("Podľa § 193 ods.1 zamieta obžalobu.");
    // Normal text without spaced-letter runs round-trips unchanged.
    expect(plainPara.plainText).toBe("Normálny text bez medzier.");

    // Inline text is NEVER mutated — the reader must render the
    // court's exact formatting.
    expect(plainTextOf(holding.inlines)).toBe("r o z h o d o l :");
    expect(plainTextOf(holdingPara.inlines)).toBe(
      "Podľa § 193 ods.1 z a m i e t a obžalobu.",
    );
    expect(plainTextOf(plainPara.inlines)).toBe("Normálny text bez medzier.");
  });

  test("preserves external keys without changing nested prototypes", () => {
    const ast: DocumentAst = {
      version: 1,
      source: { system: "test", documentId: "x", webUrl: "", printUrl: "" },
      metadata: { ...astMetadata },
      blocks: [],
    };
    Object.defineProperty(ast.metadata, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { label: "A\u0000B", polluted: true },
      writable: true,
    });

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }

    expect(Object.getPrototypeOf(sanitized.documentAst.metadata)).toBe(
      Object.prototype,
    );
    expect(Object.hasOwn(sanitized.documentAst.metadata, "__proto__")).toBe(
      true,
    );
    expect(Reflect.get(sanitized.documentAst.metadata, "__proto__")).toEqual({
      label: "AB",
      polluted: true,
    });
    expect(
      Reflect.get(sanitized.documentAst.metadata, "polluted"),
    ).toBeUndefined();
  });

  test("table cell plainText is collapsed, inline text stays verbatim", () => {
    const ast: DocumentAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "x",
        webUrl: "",
        printUrl: "",
      },
      metadata: astMetadata,
      blocks: [
        {
          id: "b1",
          anchorId: "t1",
          type: "table",
          plainText: "z a m i e t a\nplain cell",
          rows: [
            [
              {
                inlines: [{ type: "text", text: "z a m i e t a" }],
                plainText: "z a m i e t a",
              },
              {
                inlines: [{ type: "text", text: "plain cell" }],
                plainText: "plain cell",
              },
            ],
          ],
        },
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }
    const table = sanitized.documentAst.blocks[0];
    if (table?.type !== "table") {
      throw new Error("expected table");
    }
    const [firstRow] = table.rows;
    const [spacedCell, plainCell] = firstRow ?? [];
    if (!spacedCell || !plainCell) {
      throw new Error("expected two cells in first row");
    }

    expect(spacedCell.plainText).toBe("zamieta");
    expect(plainCell.plainText).toBe("plain cell");

    expect(plainTextOf(spacedCell.inlines)).toBe("z a m i e t a");
    expect(plainTextOf(plainCell.inlines)).toBe("plain cell");
  });

  test("keeps short runs of Czech/Slovak single-letter words intact", () => {
    const para = (id: string, text: string) => ({
      id,
      anchorId: id,
      type: "paragraph" as const,
      inlines: [{ type: "text" as const, text }],
      plainText: text,
    });
    const ast: DocumentAst = {
      version: 1,
      source: { system: "test", documentId: "x", webUrl: "", printUrl: "" },
      metadata: astMetadata,
      blocks: [
        // "u a v" are three real prepositions, not letter-spaced emphasis.
        para("p1", "bydlel u a v dome"),
        para("p2", "podiel i s príslušenstvom"),
        // A genuine letter-spaced word (>= 4 letters) must still collapse.
        para("p3", "súd r o z h o d o l takto"),
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }
    const [prep1, prep2, spaced] = sanitized.documentAst.blocks;
    if (
      prep1?.type !== "paragraph" ||
      prep2?.type !== "paragraph" ||
      spaced?.type !== "paragraph"
    ) {
      throw new Error("unexpected block types");
    }

    expect(prep1.plainText).toBe("bydlel u a v dome");
    expect(prep2.plainText).toBe("podiel i s príslušenstvom");
    expect(spaced.plainText).toBe("súd rozhodol takto");
  });
});

describe("runIngestionPipeline — database timeouts", () => {
  test("holds the source cursor when a decision DB operation times out", async () => {
    const source = caseLawSourceRow({ name: "Timeout source" });

    const decision = baseResult({});
    czNsAdapter.fetchPage = async () =>
      Result.ok({ decisions: [decision], nextCursor: "cursor-2" });

    let calls = 0;
    let persistedCursor: string | null | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      calls++;

      if (calls === 1) {
        throw new TimeoutError({
          message: "decision write exceeded deadline",
          label: "ingestion-db-transaction",
          timeoutMs: 10,
        });
      }

      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () =>
                await Promise.resolve(
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.CZ_NS }]
                    : [],
                ),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        update: (table: unknown) => ({
          set: (values: { syncCursor?: string | null }) => {
            if (table === caseLawSources) {
              persistedCursor = values.syncCursor;
            }

            return {
              where: () => ({
                returning: async () => [
                  { cursor: values.syncCursor ?? null, order: 1n },
                ],
              }),
            };
          },
        }),
      };

      // SAFETY: this test exercises only the final case_law_sources cursor
      // update after the synthetic timeout; the fake implements that chain.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
    });

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.haltReason?.startsWith("Database timeout;")).toBe(true);
    expect(result.stopKind).toBe(INGESTION_STOP_KIND.INTERNAL_ERROR);
    expect(persistedCursor).toBe("cursor-1");
  });
});

describe("runIngestionPipeline — failure records", () => {
  type FailureRow = typeof caseLawIngestionFailures.$inferInsert;

  /**
   * Reject the third database call to simulate a decision failure after its
   * observation and source read. With rejection disabled, planning reads reach
   * storage validation; both paths record the refusal and advance the cursor.
   */
  const failingDecisionDb = (
    insertError: Error | null,
    rejectDecisionWrite = true,
  ) => {
    const state: {
      persistedCursor: string | null | undefined;
      insertedRows: FailureRow[];
      decisionWrites: number;
    } = { persistedCursor: undefined, insertedRows: [], decisionWrites: 0 };
    let calls = 0;
    const scopedDb: ScopedDb = async (callback) => {
      calls++;
      if (calls === 3 && rejectDecisionWrite) {
        throw new Error("decision rejected\u0000at byte 12");
      }

      const tx = {
        query: {
          caseLawDecisions: {
            findFirst: async () => undefined,
            findMany: async () => [],
          },
        },
        select: () => ({
          from: (table: unknown) => ({
            // oxlint-disable-next-line typescript/promise-function-async -- returns awaitable rows with for/limit chains; async would discard those methods
            where: () =>
              Object.assign(Promise.resolve([]), {
                for: () => ({ limit: async () => [] }),
                limit: async () =>
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.CZ_NS }]
                    : [],
              }),
          }),
        }),
        insert: (table: unknown) => ({
          values: async (rows: FailureRow[]) => {
            if (table === caseLawDecisions) {
              state.decisionWrites++;
              throw new Error("unexpected decision write");
            }
            if (insertError !== null) {
              throw insertError;
            }
            state.insertedRows.push(...rows);
            return await Promise.resolve([]);
          },
        }),
        execute: async () => await Promise.resolve([]),
        update: (table: unknown) => ({
          set: (values: { syncCursor?: string | null }) => {
            if (table === caseLawDecisions) {
              state.decisionWrites++;
            }
            if (table === caseLawSources) {
              state.persistedCursor = values.syncCursor;
            }

            return {
              where: () => ({
                returning: async () => [
                  { cursor: values.syncCursor ?? null, order: 1n },
                ],
              }),
            };
          },
        }),
      };

      // SAFETY: this fake implements identity and polarity reads, failure-record
      // inserts and cursor updates; a decision insert fails explicitly.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };
    return { scopedDb, state };
  };

  const postgresError = (sqlState: string): Error =>
    new SQL.PostgresError("failure record insert rejected", {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: sqlState,
      detail: "",
      hint: "",
      severity: "ERROR",
    });

  let logs: RecordingLogger | null = null;

  afterEach(() => {
    logs?.restore();
    logs = null;
  });

  for (const field of ["caseNumber", "court"] as const) {
    test(`records an overwidth ${field} normalization refusal and advances the cursor`, async () => {
      const source = caseLawSourceRow({ name: "Normalization failure source" });
      const value = "X".repeat(CITATION_STORAGE_WIDTHS[field] + 1);
      const input = plainTextIngestionResult({
        ...baseResult({}),
        [field]: value,
      });
      czNsAdapter.fetchPage = async () =>
        Result.ok({ decisions: [input], nextCursor: "cursor-2" });
      // Normalization refuses before the decision write; the ledger insert is
      // the next transaction and must not receive a synthetic write failure.
      const { scopedDb, state } = failingDecisionDb(null, false);
      const result = await runIngestionPipeline({
        acquireStoredTotalAdmission: async () => "held",
        source,
        sourceLease: testSourceLease(source),
        scopedDb,
        maxPages: 1,
      });
      expect(state.insertedRows).toHaveLength(1);
      const [row] = state.insertedRows;
      expect(row?.caseNumber).toBe(
        input.caseNumber.slice(0, CITATION_STORAGE_WIDTHS.caseNumber),
      );
      expect(row?.errorMessage).toContain(
        field === "caseNumber"
          ? "Decision number exceeds storage limits"
          : "Decision court exceeds storage limits",
      );
      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.haltReason).toBeNull();
      expect(result.nextCursor).toBe("cursor-2");
      expect(state.persistedCursor).toBe("cursor-2");
    });
  }

  test("records an aggregate search-candidate byte refusal before writing and advances the cursor", async () => {
    const source = caseLawSourceRow({
      name: "Search candidate failure source",
    });
    const input = plainTextIngestionResult({
      ...baseResult(EMPTY_AST),
      decisionType: "é".repeat(
        CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES / Buffer.byteLength("é"),
      ),
      fulltext: "Decision text",
    });
    expect(fitsDecisionSearchCandidateRow(input)).toBe(false);
    czNsAdapter.fetchPage = async () =>
      Result.ok({ decisions: [input], nextCursor: "cursor-2" });
    const { scopedDb, state } = failingDecisionDb(null, false);
    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
      maxPages: 1,
    });
    expect(state.insertedRows).toHaveLength(1);
    expect(state.insertedRows.at(0)?.errorMessage).toContain(
      "Decision search candidate exceeds storage byte limits",
    );
    expect(state.decisionWrites).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.haltReason).toBeNull();
    expect(result.nextCursor).toBe("cursor-2");
    expect(state.persistedCursor).toBe("cursor-2");
  });

  test.each(["text", "normalizedIdentifier"] as const)(
    "records an extracted citation exceeding %s width before writing the decision and advances the cursor",
    async (field) => {
      const source = caseLawSourceRow({ name: "Citation failure source" });
      const prefix = "ECLI:CZ:NS:2026:";
      const prefixLength =
        field === "text"
          ? prefix.length
          : normalizeDecisionIdentifierValue(
              DECISION_IDENTIFIER_TYPES.ECLI,
              prefix,
            ).length;
      const citationText =
        prefix + "1".repeat(CITATION_STORAGE_WIDTHS[field] + 1 - prefixLength);
      const citations = extractCitations([{ index: 0, text: citationText }]);
      expect(citations).toHaveLength(1);
      const citation = citations.at(0);
      expect(citation?.citationText).toBe(citationText);
      if (citation === undefined) {
        throw new Error("Expected an extracted citation");
      }
      const storedValue =
        field === "text"
          ? citation.citationText
          : normalizeDecisionIdentifierValue(
              citation.identifierType,
              citation.identifierValue,
            );
      expect(storedValue.length).toBe(CITATION_STORAGE_WIDTHS[field] + 1);
      const input = plainTextIngestionResult({
        ...baseResult(EMPTY_AST),
        fulltext: citationText,
      });
      czNsAdapter.fetchPage = async () =>
        Result.ok({ decisions: [input], nextCursor: "cursor-2" });
      const { scopedDb, state } = failingDecisionDb(null, false);

      const result = await runIngestionPipeline({
        acquireStoredTotalAdmission: async () => "held",
        source,
        sourceLease: testSourceLease(source),
        scopedDb,
        maxPages: 1,
      });

      expect(state.insertedRows).toHaveLength(1);
      expect(state.insertedRows.at(0)?.errorMessage).toContain(
        `Citation field ${field} exceeds its storage width`,
      );
      expect(state.decisionWrites).toBe(0);
      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.haltReason).toBeNull();
      expect(result.nextCursor).toBe("cursor-2");
      expect(state.persistedCursor).toBe("cursor-2");
    },
  );

  test("writes a failure record within the column limits and moves the cursor on", async () => {
    const source = caseLawSourceRow({ name: "Failure-record source" });
    const caseNumber = "X".repeat(CITATION_STORAGE_WIDTHS.caseNumber);
    czNsAdapter.fetchPage = async () =>
      Result.ok({
        decisions: [
          plainTextIngestionResult({
            ...baseResult({}),
            caseNumber,
            language: "sk-SK-x-long",
          }),
        ],
        itemBuildFailures: { type: "item_build_failed", count: 2 },
        nextCursor: "cursor-2",
      });
    const { scopedDb, state } = failingDecisionDb(null);
    logs = installRecordingLogger();

    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
      maxPages: 1,
    });

    expect(state.insertedRows).toHaveLength(1);
    const [row] = state.insertedRows;
    expect(row?.caseNumber).toBe(caseNumber.slice(0, 256));
    expect(row?.language).toBe("sk-SK-x-");
    expect(row?.errorMessage).toContain("decision rejectedat byte 12");
    expect(result.skipped).toBe(1);
    expect(result.haltReason).toBeNull();
    expect(result.nextCursor).toBe("cursor-2");
    expect(state.persistedCursor).toBe("cursor-2");
    expect(
      logs.records.find(
        ({ message }) => message === "case_law.ingestion.pipeline_page_done",
      )?.attributes?.["itemBuildFailures"],
    ).toBe(2);
  });

  test("reports a failure record the database rejects as invalid data and moves the cursor on", async () => {
    const source = caseLawSourceRow({ name: "Failure-record source" });
    czNsAdapter.fetchPage = async () =>
      Result.ok({ decisions: [baseResult({})], nextCursor: "cursor-2" });
    const { scopedDb, state } = failingDecisionDb(postgresError("22021"));
    logs = installRecordingLogger();

    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
      maxPages: 1,
    });

    expect(state.persistedCursor).toBe("cursor-2");
    expect(result.haltReason).toBeNull();
    expect(
      logs
        .at("ERROR")
        .filter(
          ({ message }) =>
            message === "case_law.ingestion.failure_records_not_written",
        ),
    ).toHaveLength(1);
  });

  test("holds the source cursor when the failure record write meets a serialization failure", async () => {
    const source = caseLawSourceRow({ name: "Failure-record source" });
    czNsAdapter.fetchPage = async () =>
      Result.ok({ decisions: [baseResult({})], nextCursor: "cursor-2" });
    const { scopedDb, state } = failingDecisionDb(postgresError("40001"));

    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
      maxPages: 1,
    });

    expect(state.persistedCursor).toBe("cursor-1");
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.pagesProcessed).toBe(0);
    expect(result.haltReason).toContain("cursor held for retry");
    expect(result.stopKind).toBe(INGESTION_STOP_KIND.INTERNAL_ERROR);
    expect(result.skipped).toBe(1);
  });
});

describe("runIngestionPipeline — empty-page cursor progress", () => {
  test("persists the fetched cursor when the cycle aborts on an empty page", async () => {
    const source = caseLawSourceRow({ name: "Empty-page source" });

    // The cycle deadline fires while the fetch is in flight; the page it
    // returns carries no decisions but real cursor progress. Acquiring the
    // DB slot here used to throw AbortError before the cursor advance ran,
    // pinning the adapter to the same cursor on every later cycle.
    const controller = new AbortController();
    czNsAdapter.fetchPage = async () => {
      controller.abort();
      return Result.ok({ decisions: [], nextCursor: "cursor-2" });
    };

    let acquires = 0;
    const dbSlot = {
      acquire: async (signal?: AbortSignal) => {
        acquires++;
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
      },
      release: () => undefined,
    };

    let persistedCursor: string | null | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () =>
                await Promise.resolve(
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.CZ_NS }]
                    : [],
                ),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        update: (table: unknown) => ({
          set: (values: { syncCursor?: string | null }) => {
            if (table === caseLawSources) {
              persistedCursor = values.syncCursor;
            }

            return {
              where: () => ({
                returning: async () => [
                  { cursor: values.syncCursor ?? null, order: 1n },
                ],
              }),
            };
          },
        }),
      };

      // SAFETY: this test exercises only the final case_law_sources cursor
      // update (the empty page performs no decision writes); the fake
      // implements that chain.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
      cycle: { budgetMs: 60_000, abortEarlyOn: [controller.signal] },
      maxPages: 1,
      dbSlot,
    });

    // An empty page has no DB work, so the slot must never be contended.
    expect(acquires).toBe(0);
    expect(result.pagesProcessed).toBe(1);
    expect(result.nextCursor).toBe("cursor-2");
    expect(persistedCursor).toBe("cursor-2");
  });
});

describe("runIngestionPipeline — document observer failures", () => {
  test("observer failures preserve the result and cursor-write trace", async () => {
    const source = caseLawSourceRow({ name: "Document observer source" });
    const run = async ({ observe }: { observe?: DocumentStageObserver }) => {
      const cursorWrites: (string | null | undefined)[] = [];

      const wrappedAdapter = defineSourceAdapter({
        ...czNsAdapter,
        documentStage: ADAPTER_MANIFESTS[czNsAdapter.key].documentStage,
        fetchPage: async () => {
          for (let fetch = 0; fetch < 100; fetch++) {
            await observePublisherDocumentFetch({
              source: czNsAdapter.key,
              fetch: async () => new Response("document"),
            });
          }
          return Result.ok({ decisions: [], nextCursor: "cursor-2" });
        },
      });
      czNsAdapter.fetchPage = wrappedAdapter.fetchPage;
      expect(getAdapter(source.adapterKey)).toBe(czNsAdapter);

      const logs = installRecordingLogger();
      const leaseEffects: string[] = [];
      const result = await runIngestionPipeline({
        acquireStoredTotalAdmission: async () => "held",
        source,
        sourceLease: {
          ...testSourceLease(source),
          beforeRemoteEffect: async (effect) => {
            leaseEffects.push("remote");
            return await effect();
          },
        },
        scopedDb: cursorOnlyDb((cursor) => {
          cursorWrites.push(cursor);
        }),
        maxPages: 1,
        ...(observe ? { onDocumentObservation: observe } : {}),
      }).finally(() => logs.restore());

      return {
        cursorWrites,
        finalCursor: cursorWrites.at(-1),
        result,
        leaseEffects,
        failures: logs.records.filter(
          ({ message }) => message === DOCUMENT_FETCH_EVENT.observerFailed,
        ),
        fetchEvents: logs.records.filter(
          ({ message }) => message === DOCUMENT_FETCH_EVENT.fetchOutcome,
        ).length,
      };
    };

    const baseline = await run({});
    expect(baseline.cursorWrites).toEqual(["cursor-2"]);
    expect(baseline.result.nextCursor).toBe("cursor-2");
    const failures: { name: string; observe: DocumentStageObserver }[] = [
      {
        name: "throw",
        observe: () => {
          throw new Error("observer threw");
        },
      },
      {
        name: "reject",
        observe: async () => {
          throw new Error("observer rejected");
        },
      },
      {
        name: "never resolve",
        observe: async () => await new Promise<void>(() => {}),
      },
    ];

    for (const { name, observe } of failures) {
      const startedAt = performance.now();
      const actual = await run({ observe });
      expect(performance.now() - startedAt, name).toBeLessThan(2500);
      expect(actual.result, name).toEqual(baseline.result);
      expect(actual.cursorWrites, name).toEqual(baseline.cursorWrites);
      expect(actual.finalCursor, name).toBe(baseline.finalCursor);
      expect(actual.leaseEffects, name).toEqual(baseline.leaseEffects);
      expect(actual.fetchEvents, name).toBe(100);
      expect(actual.failures, name).toHaveLength(1);
      expect(actual.failures.at(0)?.attributes?.["reason"], name).toBe(
        "circuit_open",
      );
    }
  });
});

describe("runIngestionPipeline — cycle deadline", () => {
  for (const stopKind of [
    "source_unreachable",
    "publisher_refusal",
    "adapter_error",
  ] as const) {
    test(`propagates ${stopKind} and holds the last cursor`, async () => {
      const source = caseLawSourceRow({ name: "Stopped source" });
      czNsAdapter.fetchPage = async () =>
        Result.err(
          new AdapterFetchError({
            message: "Page unavailable",
            adapterKey: "cz-ns",
            cursor: source.syncCursor,
            stopKind,
          }),
        );
      let persistedCursor: string | null | undefined;
      const result = await runIngestionPipeline({
        source,
        sourceLease: testSourceLease(source),
        acquireStoredTotalAdmission: async () => "held",
        scopedDb: cursorOnlyDb((cursor) => {
          persistedCursor = cursor;
        }),
        maxPages: 1,
      });
      expect(result.stopKind).toBe(stopKind);
      expect(result.pagesProcessed).toBe(0);
      expect(result.nextCursor).toBe(source.syncCursor);
      expect(persistedCursor).toBe(source.syncCursor);
    });
  }

  test("classifies a publisher 503 without an injected stop kind", async () => {
    const source = caseLawSourceRow({ name: "Unavailable source" });
    czNsAdapter.fetchPage = async () =>
      Result.err(
        new AdapterFetchError({
          message: "Publisher unavailable",
          adapterKey: "cz-ns",
          cursor: source.syncCursor,
          httpStatus: 503,
        }),
      );
    const result = await runIngestionPipeline({
      source,
      sourceLease: testSourceLease(source),
      acquireStoredTotalAdmission: async () => "held",
      scopedDb: cursorOnlyDb(() => undefined),
    });
    expect(result.stopKind).toBe(INGESTION_STOP_KIND.SOURCE_UNREACHABLE);
    expect(result.nextCursor).toBe(source.syncCursor);
  });

  test.each([
    { ending: "request", expected: INGESTION_STOP_KIND.SOURCE_UNREACHABLE },
    { ending: "cycle", expected: INGESTION_STOP_KIND.DEADLINE },
  ] as const)(
    "classifies a rejected fetch when the $ending budget expires",
    async ({ ending, expected }) => {
      const source = caseLawSourceRow({ name: "Rejected-fetch source" });
      const drain = new AbortController();
      let fetches = 0;
      czNsAdapter.fetchPage = async (_cursor, _config, signal) => {
        fetches++;
        expect(signal?.aborted).toBe(false);
        if (ending === "cycle") {
          drain.abort();
        }
        expect(signal?.aborted).toBe(ending === "cycle");
        throw new DOMException("The request timed out", "TimeoutError");
      };
      let persistedCursor: string | null | undefined;
      const result = await runIngestionPipeline({
        source,
        sourceLease: testSourceLease(source),
        acquireStoredTotalAdmission: async () => "held",
        scopedDb: cursorOnlyDb((cursor) => {
          persistedCursor = cursor;
        }),
        cycle: { budgetMs: 60_000, abortEarlyOn: [drain.signal] },
      });
      expect(fetches).toBe(1);
      expect(result.stopKind).toBe(expected);
      expect(result.pagesProcessed).toBe(0);
      expect(result.nextCursor).toBe(source.syncCursor);
      expect(persistedCursor).toBe(source.syncCursor);
    },
  );

  test("a failed source-raw write holds the cursor as an internal error", async () => {
    const source = caseLawSourceRow({ name: "Write-failure source" });
    const fake = startFakeS3();
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    czNsAdapter.fetchPage = async () =>
      Result.ok({
        decisions: [
          { ...baseResult(EMPTY_AST), sourceRaw: "<html>source</html>" },
        ],
        nextCursor: "cursor-2",
      });
    try {
      const result = await runIngestionPipeline({
        source,
        sourceLease: testSourceLease(source),
        acquireStoredTotalAdmission: async () => "held",
        scopedDb: cursorOnlyDb(() => undefined),
        maxPages: 1,
      });
      expect(
        fake.requests.filter(({ method }) => method === "PUT"),
      ).toHaveLength(1);
      expect(result.haltReason).toContain("source raw write failure");
      expect(result.stopKind).toBe(INGESTION_STOP_KIND.INTERNAL_ERROR);
      expect(result.pagesProcessed).toBe(0);
      expect(result.nextCursor).toBe(source.syncCursor);
    } finally {
      fake.stop();
    }
  });

  test("the cycle deadline overrides a typed publisher refusal", async () => {
    const source = caseLawSourceRow({ name: "Deadline source" });
    const drain = new AbortController();
    czNsAdapter.fetchPage = async () => {
      drain.abort();
      return Result.err(
        new AdapterFetchError({
          message: "Publisher refusal at cycle end",
          adapterKey: "cz-ns",
          cursor: source.syncCursor,
          httpStatus: 403,
        }),
      );
    };
    const result = await runIngestionPipeline({
      source,
      sourceLease: testSourceLease(source),
      acquireStoredTotalAdmission: async () => "held",
      scopedDb: cursorOnlyDb(() => undefined),
      cycle: { budgetMs: 60_000, abortEarlyOn: [drain.signal] },
    });
    expect(result.stopKind).toBe(INGESTION_STOP_KIND.DEADLINE);
    expect(result.pagesProcessed).toBe(0);
  });

  test("a page budget timeout is a deadline while the cycle still has time", async () => {
    const source = caseLawSourceRow({ name: "Page-budget source" });
    const originalPageTimeout = czNsAdapter.pageTimeoutMs;
    const originalFetch = czNsAdapter.fetchPage;
    czNsAdapter.pageTimeoutMs = 1;
    czNsAdapter.fetchPage = async (_cursor, _config, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return Result.err(
        new AdapterFetchError({
          message: "Page request stopped",
          adapterKey: "cz-ns",
          cursor: source.syncCursor,
          httpStatus: 403,
        }),
      );
    };
    try {
      const result = await runIngestionPipeline({
        source,
        sourceLease: testSourceLease(source),
        acquireStoredTotalAdmission: async () => "held",
        scopedDb: cursorOnlyDb(() => undefined),
        cycle: { budgetMs: 60_000 },
      });
      expect(result.stopKind).toBe(INGESTION_STOP_KIND.DEADLINE);
      expect(result.pagesProcessed).toBe(0);
    } finally {
      czNsAdapter.pageTimeoutMs = originalPageTimeout;
      czNsAdapter.fetchPage = originalFetch;
    }
  });

  test("stops before a page the remaining budget cannot cover", async () => {
    const source = caseLawSourceRow({ name: "Short-budget source" });

    let fetches = 0;
    czNsAdapter.fetchPage = async () => {
      fetches++;
      return Result.ok({ decisions: [], nextCursor: "cursor-2" });
    };

    let persistedCursor: string | null | undefined;
    // cz-ns takes the default 30s page timeout, so this page is aborted at
    // the cycle deadline long before it can finish. The deadline has not
    // fired yet: it is the remaining budget, not the abort, that decides.
    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb: cursorOnlyDb((cursor) => {
        persistedCursor = cursor;
      }),
      cycle: { budgetMs: 10 },
    });

    expect(fetches).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.haltReason).toBe(CYCLE_HALT_REASON.TIMEOUT);
    expect(result.stopKind).toBe("deadline");
    expect(result.nextCursor).toBe("cursor-1");
    expect(persistedCursor).toBe("cursor-1");
  });

  test("stops when the lease renewal spends the rest of the budget", async () => {
    const source = caseLawSourceRow({ name: "Renewal source" });

    let fetches = 0;
    czNsAdapter.fetchPage = async () => {
      fetches++;
      return Result.ok({ decisions: [], nextCursor: "cursor-2" });
    };

    // The production lease renews itself before the request. This one ends
    // the cycle while doing so, which is what a renewal that outlasts the
    // remaining budget looks like from the page loop.
    const drain = new AbortController();
    let renewals = 0;
    const lease: CaseLawSourceIngestionLease = {
      ...testSourceLease(source),
      beforeRemoteEffect: async (effect) => {
        renewals++;
        drain.abort();
        return await effect();
      },
    };

    let persistedCursor: string | null | undefined;
    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: lease,
      scopedDb: cursorOnlyDb((cursor) => {
        persistedCursor = cursor;
      }),
      cycle: { budgetMs: 60_000, abortEarlyOn: [drain.signal] },
    });

    // The page was admitted — the renewal ran — and refused after it.
    expect(renewals).toBe(1);
    expect(fetches).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.haltReason).toBe(CYCLE_HALT_REASON.TIMEOUT);
    expect(persistedCursor).toBe("cursor-1");
  });

  test("runs a page that fits in the remaining budget", async () => {
    const source = caseLawSourceRow({ name: "Full-budget source" });

    let fetches = 0;
    czNsAdapter.fetchPage = async () => {
      fetches++;
      return Result.ok({ decisions: [], nextCursor: null });
    };

    let persistedCursor: string | null | undefined;
    const result = await runIngestionPipeline({
      acquireStoredTotalAdmission: async () => "held",
      source,
      sourceLease: testSourceLease(source),
      scopedDb: cursorOnlyDb((cursor) => {
        persistedCursor = cursor;
      }),
      cycle: { budgetMs: 60_000 },
    });

    expect(fetches).toBe(1);
    expect(result.pagesProcessed).toBe(1);
    expect(result.haltReason).toBeNull();
    expect(persistedCursor).toBeNull();
  });
});

describe("wrappedErrorDetail", () => {
  test("keeps the cause when the outer message is long", () => {
    const cause = new Error("connection reset by peer");
    const outer = new Error(`Failed query: ${"select ".repeat(200)}`, {
      cause,
    });
    const detail = wrappedErrorDetail(outer);
    expect(detail).toContain("connection reset by peer");
    expect(detail.length).toBeLessThanOrEqual(200 + 300 + 16);
  });

  test("bounds the cause independently of the outer message", () => {
    const cause = new Error("x".repeat(1000));
    const detail = wrappedErrorDetail(new Error("short", { cause }));
    expect(detail.startsWith("short (cause: ")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200 + 300 + 16);
  });

  test("stringifies non-Error values", () => {
    expect(wrappedErrorDetail("boom")).toBe("boom");
  });
});

describe("processDecision — corpus storage off", () => {
  test("clears corpus pointers left behind by an earlier mode", async () => {
    // Rolling back to `off` makes the Postgres columns canonical again, and
    // no corpus write follows this refresh to rewrite the keys. Left alone,
    // the row would keep pointing at objects that no longer match its text.
    const existing = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "old-hash",
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    const sourceId = createSafeId<"caseLawSource">();

    let updated: Record<string, unknown> | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({
                limit: async () =>
                  await Promise.resolve(
                    table === caseLawSources ? [{ id: sourceId }] : [],
                  ),
              }),
              limit: async () =>
                await Promise.resolve(
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.SK_COURTS }]
                    : [],
                ),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(existing),
          },
        },
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            if (table === caseLawDecisions) {
              updated = values;
            }
            return {
              where: () => ({
                returning: async () => [{ id: existing.id }],
              }),
            };
          },
        }),
        delete: () => ({ where: async () => undefined }),
        insert: () => ({ values: insertedValues }),
      };

      // SAFETY: the refresh path walks only these chains; anything else
      // would throw and fail the test loudly.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const outcome = await processDecision({
      input: plainTextIngestionResult({
        caseNumber: "X/1/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
      }),
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome.inserted).toBe(true);
    expect(updated).toMatchObject({
      fulltext: "Rozhodnutie o veci samej.",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });
  });
});

describe("processDecision — the decision's judges", () => {
  type ReplacedJudges = {
    decisionId: string;
    judges: readonly { role: string; nameAsPrinted: string }[];
    /** Whether the write happened inside the transaction that wrote the row. */
    inTransaction: boolean;
  };

  type RefreshOptions = {
    judges?: RawIngestionResult["judges"];
  };

  const refreshWithJudges = async ({
    judges,
  }: RefreshOptions): Promise<ReplacedJudges[]> => {
    const existing = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "old-hash",
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    const sourceId = createSafeId<"caseLawSource">();
    const replaced: ReplacedJudges[] = [];
    let inTransaction = false;

    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({
                limit: async () =>
                  await Promise.resolve(
                    table === caseLawSources ? [{ id: sourceId }] : [],
                  ),
              }),
              limit: async () =>
                await Promise.resolve(
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.SK_COURTS }]
                    : [],
                ),
            }),
          }),
        }),
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(existing),
          },
        },
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [{ id: existing.id }],
            }),
          }),
        }),
        delete: () => ({ where: async () => undefined }),
        insert: () => ({ values: insertedValues }),
      };

      inTransaction = true;
      try {
        // SAFETY: the refresh path walks only these chains; anything else
        // would throw and fail the test loudly.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return await callback(tx as unknown as Transaction);
      } finally {
        inTransaction = false;
      }
    };

    await processDecision({
      input: plainTextIngestionResult({
        ...baseResult(EMPTY_AST),
        fulltext: "Ústavní soud rozhodl o návrhu.",
        ...(judges === undefined ? {} : { judges }),
      }),
      judges: {
        replace: async (_tx, { decisionId, judges: written }) => {
          replaced.push({ decisionId, judges: written, inTransaction });
          await Promise.resolve();
        },
      },
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    return replaced;
  };

  test("writes them in the transaction that writes the decision row", async () => {
    const replaced = await refreshWithJudges({
      judges: [
        { role: "rapporteur", nameAsPrinted: "Nováková Jana" },
        { role: "dissenting", nameAsPrinted: "Dvořák Petr" },
      ],
    });

    expect(replaced).toHaveLength(1);
    expect(replaced.at(0)?.judges).toEqual([
      { role: "rapporteur", nameAsPrinted: "Nováková Jana" },
      { role: "dissenting", nameAsPrinted: "Dvořák Petr" },
    ]);
    // Outside it, a row could keep the judges of a decision it no longer is.
    expect(replaced.at(0)?.inTransaction).toBe(true);
  });

  test("leaves the stored judges alone for an observation that names none", async () => {
    expect(await refreshWithJudges({})).toEqual([]);
  });
});

describe("processDecision — fields on an existing row", () => {
  // An update omits an undefined column, so a rejected date has to be
  // distinguishable from an unstated one all the way to the write: the
  // first must clear whatever the row holds, the second must not.
  type RefreshedDecisionOptions = {
    decisionDate?: string | undefined;
    storedMetadata?: Record<string, unknown> | undefined;
    textFields?: RawIngestionResult["textFields"] | undefined;
  };

  const refreshedDecision = async ({
    decisionDate,
    storedMetadata = {},
    textFields = absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  }: RefreshedDecisionOptions): Promise<
    Record<string, unknown> | undefined
  > => {
    const existing = {
      id: createSafeId<"caseLawDecision">(),
      metadata: storedMetadata,
      sourceHash: "old-hash",
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    const sourceId = createSafeId<"caseLawSource">();

    let updated: Record<string, unknown> | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // Return the locked row state used by the refresh path.
        select: () => ({
          from: (table: unknown) =>
            table === caseLawDecisionIdentifiers
              ? {
                  where: async () => [
                    {
                      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                      normalizedValue: bareCitationKey("X/1/2026"),
                    },
                  ],
                }
              : {
                  where: () => ({
                    for: () => ({
                      limit: async () =>
                        await Promise.resolve(
                          table === caseLawSources
                            ? [{ id: sourceId }]
                            : [
                                {
                                  citationKey: bareCitationKey("X/1/2026"),
                                  country: "SVK",
                                  language: "sk",
                                  decisionDate:
                                    decisionDate === undefined
                                      ? null
                                      : canonicalDecisionDate(
                                          decisionDate,
                                          "SVK",
                                        ),
                                  metadata: storedMetadata,
                                },
                              ],
                        ),
                    }),
                    limit: async () =>
                      await Promise.resolve(
                        table === caseLawSources
                          ? [{ adapterKey: ADAPTER_KEYS.SK_COURTS }]
                          : [],
                      ),
                  }),
                },
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(existing),
          },
        },
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            if (table === caseLawDecisions) {
              updated = values;
            }
            return {
              where: () => ({
                returning: async () => [{ id: existing.id }],
              }),
            };
          },
        }),
        delete: () => ({ where: async () => undefined }),
        insert: () => ({ values: insertedValues }),
      };

      // SAFETY: the refresh path walks only these chains; anything else
      // would throw and fail the test loudly.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    await processDecision({
      input: plainTextIngestionResult({
        caseNumber: "X/1/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        decisionDate,
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        textFields,
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
      }),
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    return updated;
  };

  test("clears the column when the source restates an unusable date", async () => {
    const updated = await refreshedDecision({ decisionDate: "2944-04-30" });

    expect(updated?.["decisionDate"]).toBeNull();
  });

  test("writes a usable date", async () => {
    const updated = await refreshedDecision({ decisionDate: "2026-04-15" });

    expect(updated?.["decisionDate"]).toBe("2026-04-15");
  });

  test("writes nothing when the source states no date", async () => {
    const updated = await refreshedDecision({});

    expect(updated?.["decisionDate"]).toBeUndefined();
  });

  test("keeps stored decision text when parsing fails", async () => {
    const updated = await refreshedDecision({
      storedMetadata: { abstract: "Stored abstract" },
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        abstract: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
      },
    });

    expect(updated?.["metadata"]).toEqual({
      abstract: "Stored abstract",
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: DECISION_TEXT_FIELD.HEADNOTE,
          reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
        },
        {
          field: DECISION_TEXT_FIELD.LEGAL_SENTENCE,
          reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
        },
        {
          field: DECISION_TEXT_FIELD.SUMMARY,
          reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
        },
      ],
    });
  });
});

describe("processDecision — source raw upload failure", () => {
  let fake: FakeS3;
  let logs: RecordingLogger;

  beforeEach(() => {
    fake = startFakeS3();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    logs.restore();
    fake.stop();
  });

  /** The key the raw payload is content-addressed under. */
  /** The payload's own digest, under the decision's own raw prefix. */
  const rawKey = (sourceId: string, payload: string): RegExp =>
    new RegExp(
      `^case-law/raw/${sourceId}/documents/[0-9a-f-]{36}/payloads/${new Bun.CryptoHasher("sha256").update(payload).digest("hex")}$`,
      "u",
    );

  test("reports a new decision's failed raw upload as retryable, not thrown", async () => {
    // A thrown failure is caught by the decision loop, counted as skipped,
    // and lets the page's cursor advance; a forward-only traversal then
    // never returns to the decision and its raw source is lost. Only a
    // retryable outcome reaches the page-level cursor hold.
    //
    // The store rejects the write the way it rejects a denied one in
    // production: `AccessDenied` is terminal, so the retry inside
    // `writeS3ObjectWithRetry` does not turn this into three attempts.
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    const sourceId = createSafeId<"caseLawSource">();
    const sourceRaw = "<html></html>";

    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () =>
                await Promise.resolve(
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.SK_COURTS }]
                    : [],
                ),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(undefined),
          },
        },
      };

      // SAFETY: the raw upload runs before any decision write, so the
      // dedup lookup is the only chain this path reaches.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const outcome = await processDecision({
      input: plainTextIngestionResult({
        caseNumber: "X/2/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
        sourceRaw,
      }),
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-08-03T00:00:00.000Z"),
    });

    if (outcome.status !== "retryable") {
      throw new Error(`expected a retryable outcome, got ${outcome.status}`);
    }

    expect(outcome.inserted).toBe(false);
    // The reason selects the halt message and keeps this failure
    // attributable apart from a corpus-write failure, so pin it: asserting
    // only the status would pass on the corpus-write reason too.
    expect(outcome.reason).toBe("source-raw-write");
    // The rejected write was the payload's own content-addressed key in the
    // case-law partition, and nothing landed: the held cursor is the only
    // record of this decision, so the retry has the whole upload to redo.
    const writes = fake.requests.filter(({ method }) => method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.bucket).toBe(envBase.S3_BUCKET);
    expect(writes.at(0)?.key).toMatch(rawKey(sourceId, sourceRaw));
    // The charset parameter is the client's; the media type is the
    // pipeline's, and it is what a re-parse reads the object back as.
    expect(writes.at(0)?.contentType).toMatch(/^text\/plain\b/u);
    expect(fake.objects.size).toBe(0);
  });

  test("logs the failure's system fields, not just its message", async () => {
    // Bun's S3 client collapses every write failure to the same
    // message, so `error.detail` alone cannot tell an access denial
    // from a timeout. `errorSystemFields` carries the discriminating
    // `code`/`errno`/`syscall`, which is what makes a held cursor
    // diagnosable from the log. The code comes from the store's own
    // rejection through the real client, so this also pins that the
    // client still surfaces it where `errorSystemFields` looks.
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });

    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () =>
                await Promise.resolve(
                  table === caseLawSources
                    ? [{ adapterKey: ADAPTER_KEYS.SK_COURTS }]
                    : [],
                ),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(undefined),
          },
        },
      };

      // SAFETY: the raw upload runs before any decision write, so the
      // dedup lookup is the only chain this path reaches.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    await processDecision({
      input: plainTextIngestionResult({
        caseNumber: "X/3/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
        sourceRaw: "<html></html>",
      }),
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    const failure = logs.at("ERROR").at(0);
    expect(failure?.attributes?.["error.code"]).toBe("AccessDenied");
  });
});

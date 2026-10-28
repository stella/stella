import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  DECISION_TEXT_RECOVERY,
  type DecisionTextRecovery,
} from "@stll/api-contract/case-law-fulltext-state";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";

import { plUodoAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-uodo";
import {
  PL_UOKIK_DOCUMENT_ABSENCE,
  PL_UOKIK_DOCUMENT_ABSENCE_KEY,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uokik.text-policy";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { pendingDecisionText } from "@/api/lib/case-law/fulltext-state";
import type { ClaimedDecisionTextWork } from "@/api/lib/case-law/fulltext-state-store";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import type {
  RawIngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationListingItem,
  SourceAdapter,
} from "@/api/lib/legal-search/ingestion-types";

import {
  recoverFromPublisherListing,
  terminalPublisherTextState,
} from "./fulltext-publisher-recovery";

const now = new Date("2026-10-28T12:00:00.000Z");
const rowOf = (overrides: Partial<ClaimedDecisionTextWork> = {}) =>
  ({
    id: createSafeId<"caseLawDecision">(),
    sourceId: createSafeId<"caseLawSource">(),
    sourceDocumentId: "held-document",
    sourceHash: "a".repeat(64),
    sourceObservationOrder: 1n,
    textState: pendingDecisionText({
      now,
      attemptCount: 1,
      lastAttemptAt: null,
      delayMs: 0,
    }),
    caseNumber: "II SA 123/2014",
    caseNumberType: "case-number",
    sheetNumber: null,
    decisionDate: "2014-02-01",
    country: "POL",
    language: "pl",
    court: "Court",
    ecli: null,
    decisionType: "judgment",
    sourceUrl: "https://publisher.example/record/held-document",
    documentUrl: null,
    metadata: {},
    fulltext: null,
    documentAst: null,
    sections: null,
    contentHash: null,
    textS3Key: null,
    normalizedS3Key: null,
    astS3Key: null,
    sourceRawS3Key: null,
    sourceRawContentType: null,
    sourceRaw: null,
    ...overrides,
  }) satisfies ClaimedDecisionTextWork;
const decisionOf = (overrides: Partial<RawIngestionResult> = {}) =>
  sanitizeResult({
    sourceDocumentId: "held-document",
    caseNumber: "II SA 123/2014",
    court: "Court",
    country: "POL",
    language: "pl",
    decisionDate: "2014-02-01",
    decisionType: "judgment",
    rawHash: "a".repeat(64),
    documentAst: {},
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    fulltext: "The court decided.",
    ...overrides,
  });
const item = (
  sourceDocumentId = "held-document",
): ReconciliationListingItem => ({
  identity: { type: "document", sourceDocumentId },
  payload: sourceDocumentId,
});
type FakeOptions = {
  pages?: ReconciliationListingItem[][];
  outcome?: ReconciliationBuildOutcome;
  listError?: AdapterFetchError;
};
const fake = ({
  pages = [[item()]],
  outcome = { type: "built", decision: decisionOf() },
  listError,
}: FakeOptions = {}) => {
  const listed: number[] = [];
  const built: unknown[] = [];
  const adapter = {
    ...plUodoAdapter,
    reconciliation: {
      ...plUodoAdapter.reconciliation,
      firstSlice: "2020",
      sliceOf: () => "2014",
      listSlicePage: async ({ slice, page, signal }) => {
        expect(slice).toBe("2014");
        expect(signal).toBeInstanceOf(AbortSignal);
        listed.push(page);
        if (listError) {
          throw listError;
        }
        return { items: pages.at(page) ?? [], totalPages: pages.length };
      },
      createSliceBuildDecision: () => async (payload, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        built.push(payload);
        return outcome;
      },
      buildDecision: async () => panic("Slice-local builder must be used"),
    },
  } satisfies SourceAdapter;
  return { adapter, listed, built };
};
const start = { type: DECISION_TEXT_RECOVERY.VERIFY_STORAGE } as const;
const recover = async (adapter: SourceAdapter, row = rowOf()) =>
  await recoverFromPublisherListing({
    adapter,
    row,
    recovery: start,
    signal: new AbortController().signal,
    checkpoint: async () => "applied",
  });

describe("publisher text recovery uses durable bounded source listings", () => {
  test("more than four pages resumes the exact next page beyond the ingestion floor", async () => {
    const source = fake({ pages: [[], [], [], [], [], [item()]] });
    let cursor: DecisionTextRecovery = start;
    const call = async () =>
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf(),
        recovery: cursor,
        signal: new AbortController().signal,
        checkpoint: async (next) => {
          cursor = next;
          return "applied";
        },
      });
    expect(await call()).toEqual({
      type: "continued",
      recovery: { type: "publisher_listing", slice: "2014", page: 4 },
    });
    expect(source.listed).toEqual([0, 1, 2, 3]);
    expect(await call()).toMatchObject({ type: "built" });
    expect(source.listed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(source.built).toEqual(["held-document"]);
  });
  test("a crash after a saved page resumes there and a refused checkpoint stops I/O", async () => {
    const source = fake({ pages: [[], [], [], [item()]] });
    let cursor: DecisionTextRecovery = start;
    const failed = await recoverFromPublisherListing({
      adapter: source.adapter,
      row: rowOf(),
      recovery: cursor,
      signal: new AbortController().signal,
      checkpoint: async (next) => {
        if (next.type === "publisher_listing" && next.page === 2) {
          throw new TypeError("checkpoint unavailable");
        }
        cursor = next;
        return "applied";
      },
    });
    expect(failed).toMatchObject({
      type: "failed",
      cause: { kind: "storage" },
    });
    expect(source.listed).toEqual([0, 1]);
    expect(cursor).toEqual(
      expect.objectContaining({
        type: "publisher_listing",
        slice: "2014",
        page: 1,
      }),
    );
    expect(
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf(),
        recovery: cursor,
        signal: new AbortController().signal,
        checkpoint: async (next) => {
          cursor = next;
          return "applied";
        },
      }),
    ).toMatchObject({ type: "built" });
    expect(source.listed).toEqual([0, 1, 1, 2, 3]);
  });
  test("a resumed cursor owns the slice even when a new date would select another", async () => {
    const source = fake({ pages: [[], [], [item()]] });
    source.adapter.reconciliation.sliceOf = () => "2026";
    expect(
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf({ decisionDate: "2026-02-01" }),
        recovery: { type: "publisher_listing", slice: "2014", page: 2 },
        signal: new AbortController().signal,
        checkpoint: async () => "applied",
      }),
    ).toMatchObject({ type: "built" });
    expect(source.listed).toEqual([2]);
  });
  test("a missing listing identity cannot fall back to a supplied document URL", async () => {
    const source = fake();
    expect(
      await recover(
        source.adapter,
        rowOf({
          sourceDocumentId: null,
          caseNumber: "",
          documentUrl: "https://publisher.example/held.pdf",
        }),
      ),
    ).toMatchObject({
      type: "failed",
      cause: { code: "listing_identity_missing" },
    });
    expect(source.listed).toEqual([]);
  });
  test("the matched current page is durable before building its document", async () => {
    const source = fake();
    const saved: DecisionTextRecovery[] = [];
    expect(
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf(),
        recovery: start,
        signal: new AbortController().signal,
        checkpoint: async (next) => {
          expect(source.built).toEqual([]);
          saved.push(next);
          return "applied";
        },
      }),
    ).toMatchObject({ type: "built" });
    expect(saved).toEqual([
      { type: "publisher_listing", slice: "2014", page: 0 },
    ]);
    expect(source.built).toEqual(["held-document"]);
  });
  test("a superseded matched-page checkpoint prevents the document build", async () => {
    const source = fake();
    expect(
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf(),
        recovery: start,
        signal: new AbortController().signal,
        checkpoint: async () => "superseded",
      }),
    ).toEqual({ type: "superseded" });
    expect(source.listed).toEqual([0]);
    expect(source.built).toEqual([]);
  });
  test("a superseded empty-page checkpoint stops before the next publisher read", async () => {
    const source = fake({ pages: [[], [item()]] });
    expect(
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf(),
        recovery: start,
        signal: new AbortController().signal,
        checkpoint: async () => "superseded",
      }),
    ).toEqual({ type: "superseded" });
    expect(source.listed).toEqual([0]);
    expect(source.built).toEqual([]);
  });
  test("a rejected matched-page checkpoint prevents the document build", async () => {
    const source = fake();
    expect(
      await recoverFromPublisherListing({
        adapter: source.adapter,
        row: rowOf(),
        recovery: start,
        signal: new AbortController().signal,
        checkpoint: async () => {
          throw new TypeError("matched checkpoint unavailable");
        },
      }),
    ).toMatchObject({ type: "failed", cause: { kind: "storage" } });
    expect(source.listed).toEqual([0]);
    expect(source.built).toEqual([]);
  });
  test("selects the exact publisher document among sibling sheets", async () => {
    const source = fake({
      pages: [[item("referral"), item(), item("other-sheet")]],
    });
    expect(await recover(source.adapter)).toMatchObject({ type: "built" });
    expect(source.built).toEqual(["held-document"]);
  });
  test.each([null, "invalid", "2014-02-30"])(
    "missing or invalid date never falls back to a document URL: %s",
    async (decisionDate) => {
      const source = fake();
      expect(
        await recover(
          source.adapter,
          rowOf({
            decisionDate,
            documentUrl: "https://publisher.example/file.pdf",
          }),
        ),
      ).toMatchObject({ type: "failed", cause: { kind: "parser_refusal" } });
      expect(source.listed).toEqual([]);
    },
  );
  test("a publisher error and exhausted listing remain failures without absence evidence", async () => {
    const source = fake({
      listError: new AdapterFetchError({
        message: "Publisher refused",
        adapterKey: ADAPTER_KEYS.PL_UODO,
        cursor: null,
        httpStatus: 503,
      }),
    });
    expect(await recover(source.adapter)).toEqual({
      type: "failed",
      cause: { kind: "http", status: 503 },
    });
    expect(await recover(fake({ pages: [[]] }).adapter)).toEqual({
      type: "failed",
      cause: { kind: "parser_refusal", code: "listing_identity_not_found" },
    });
  });
  test.each(["detail-unavailable", "unkeyable"] as const)(
    "typed build %s remains a retry failure",
    async (type) => {
      expect(await recover(fake({ outcome: { type } }).adapter)).toMatchObject({
        type: "failed",
        cause: { kind: "parser_refusal" },
      });
    },
  );
  test("a document read failure retains its raw response for normal ingestion before classification", async () => {
    const outcome = {
      type: "built",
      decision: decisionOf({
        fulltext: "",
        sourceRaw: "Synthetic publisher response with a malformed document.",
        sourceRawContentType: "text/html",
        metadata: {
          readOutcome: {
            consecutiveCycles: 1,
            type: "unavailable",
            scope: "document",
            cause: { kind: "status", status: 503 },
          },
        },
      }),
    } as const;
    expect(await recover(fake({ outcome }).adapter)).toEqual(outcome);
  });
  test("a newly read scanned document retains its raw response before the worker schedules OCR", async () => {
    const outcome = {
      type: "built",
      decision: decisionOf({
        fulltext: "",
        sourceRaw: "Synthetic publisher page with scanned files.",
        sourceRawContentType: "text/html",
        metadata: {
          [PL_UOKIK_DOCUMENT_ABSENCE_KEY]: PL_UOKIK_DOCUMENT_ABSENCE.SCANNED,
        },
      }),
    } as const;
    const source = fake({ outcome });
    const adapter = {
      ...source.adapter,
      key: ADAPTER_KEYS.PL_UOKIK,
    } satisfies SourceAdapter;
    expect(await recover(adapter)).toEqual(outcome);
  });
  test("duplicate declared identities are refused before any detail build", async () => {
    const source = fake({ pages: [[item(), item()]] });
    expect(await recover(source.adapter)).toMatchObject({
      type: "failed",
      cause: { code: "listing_identity_ambiguous" },
    });
    expect(source.built).toEqual([]);
  });
  test("legacy docket identities require the exact language and held document corroboration", async () => {
    const pages: ReconciliationListingItem[][] = [
      [
        {
          identity: {
            type: "case-number",
            caseNumber: "II SA 123/2014",
            language: "de",
          },
          payload: "other",
        },
        {
          identity: {
            type: "case-number",
            caseNumber: "II SA 123/2014",
            language: "pl",
          },
          payload: "held",
        },
      ],
    ];
    const source = fake({
      pages,
      outcome: {
        type: "built",
        decision: decisionOf({
          sourceDocumentId: undefined,
          ecli: "ECLI:PL:TEST:2014:123",
        }),
      },
    });
    expect(
      await recover(
        source.adapter,
        rowOf({ sourceDocumentId: null, ecli: "ECLI:PL:TEST:2014:123" }),
      ),
    ).toMatchObject({ type: "built" });
    expect(source.built).toEqual(["held"]);
    expect(
      await recover(source.adapter, rowOf({ sourceDocumentId: null })),
    ).toMatchObject({
      type: "failed",
      cause: { code: "ambiguous_legacy_identity" },
    });
    expect(
      await recover(
        source.adapter,
        rowOf({ sourceDocumentId: null, ecli: "ECLI:PL:TEST:2014:OTHER" }),
      ),
    ).toMatchObject({
      type: "failed",
      cause: { code: "ambiguous_legacy_identity" },
    });
  });
  test("an unnumbered legacy document requires its exact document locator", async () => {
    const pages: ReconciliationListingItem[][] = [
      [
        {
          identity: {
            type: "case-number",
            caseNumber: "II SA 123/2014",
            language: "pl",
          },
          payload: "held",
        },
      ],
    ];
    const documentUrl = "https://publisher.example/held.pdf";
    const source = fake({
      pages,
      outcome: {
        type: "built",
        decision: decisionOf({ sourceDocumentId: undefined, documentUrl }),
      },
    });
    expect(
      await recover(
        source.adapter,
        rowOf({ sourceDocumentId: null, documentUrl }),
      ),
    ).toMatchObject({ type: "built" });
    expect(
      await recover(
        source.adapter,
        rowOf({
          sourceDocumentId: null,
          documentUrl: "https://publisher.example/other.pdf",
        }),
      ),
    ).toMatchObject({
      type: "failed",
      cause: { code: "ambiguous_legacy_identity" },
    });
  });
  test("companions remain attached to their publisher build outcome", async () => {
    const outcome = {
      type: "built",
      decision: decisionOf(),
      companions: [decisionOf({ sourceDocumentId: "companion" })],
    } as const;
    expect(await recover(fake({ outcome }).adapter)).toEqual(outcome);
  });
  test("an exact document ID cannot replace a held sheet or ECLI with another", async () => {
    for (const row of [
      rowOf({ sheetNumber: "99" }),
      rowOf({ ecli: "ECLI:PL:TEST:2014:123" }),
    ]) {
      expect(await recover(fake().adapter, row)).toMatchObject({
        type: "failed",
        cause: { code: "ambiguous_legacy_identity" },
      });
    }
  });
  test("supplements retain their source outcome for the normal supplement pipeline", async () => {
    const supplement = {
      kind: "reasons",
      target: { decisionTypes: ["judgment"] },
      document: { ...decisionOf(), sourceDocumentId: "held-document" },
    } as const;
    const source = fake({ outcome: { type: "built-supplement", supplement } });
    expect(await recover(source.adapter)).toEqual({
      type: "built-supplement",
      supplement,
    });
  });
});

describe("terminal publisher policy requires source evidence", () => {
  test("only UODO court references qualify, never quarantined identities", () => {
    expect(
      terminalPublisherTextState({
        adapterKey: ADAPTER_KEYS.PL_UODO,
        row: rowOf({ sourceDocumentId: "urn:ndoc:court:pl:sa:2014:ii_sa_123" }),
        now,
      }),
    ).toMatchObject({ status: CASE_LAW_TEXT_STATUS.METADATA_ONLY_BY_SOURCE });
    for (const sourceDocumentId of [
      null,
      "pl-uodo-quarantine:123",
      "held-document",
    ]) {
      expect(
        terminalPublisherTextState({
          adapterKey: ADAPTER_KEYS.PL_UODO,
          row: rowOf({ sourceDocumentId }),
          now,
        }),
      ).toBeNull();
    }
  });
  test("only an explicit UOKIK no-attachment marker plus valid record evidence establishes absence", () => {
    const row = rowOf({
      sourceUrl: "https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/0/held-document",
      metadata: {
        [PL_UOKIK_DOCUMENT_ABSENCE_KEY]:
          PL_UOKIK_DOCUMENT_ABSENCE.NO_ATTACHMENT,
      },
    });
    expect(
      terminalPublisherTextState({
        adapterKey: ADAPTER_KEYS.PL_UOKIK,
        row,
        now,
      }),
    ).toMatchObject({
      status: CASE_LAW_TEXT_STATUS.PUBLISHER_HAS_NO_TEXT,
      evidence: {
        recordUrl: row.sourceUrl,
        sourceHash: row.sourceHash,
        kind: "no_document_attachment",
      },
    });
    for (const overrides of [
      { sourceHash: null },
      { sourceHash: "bad" },
      { sourceUrl: "http://publisher.example/record" },
      { sourceUrl: "https://off-origin.example/record" },
      { sourceUrl: null },
      { metadata: {} },
      { metadata: { documentAbsence: "scanned" } },
    ]) {
      expect(
        terminalPublisherTextState({
          adapterKey: ADAPTER_KEYS.PL_UOKIK,
          row: rowOf({ ...row, ...overrides }),
          now,
        }),
      ).toBeNull();
    }
    expect(
      terminalPublisherTextState({ adapterKey: ADAPTER_KEYS.CZ_NSS, row, now }),
    ).toBeNull();
  });
  test("scanned documents need OCR and never prove publisher absence", async () => {
    const source = fake();
    const adapter = {
      ...source.adapter,
      key: ADAPTER_KEYS.PL_UOKIK,
    } satisfies SourceAdapter;
    expect(
      await recover(
        adapter,
        rowOf({ metadata: { documentAbsence: "scanned" } }),
      ),
    ).toEqual({
      type: "failed",
      cause: { kind: "parser_refusal", code: "ocr_required" },
    });
    expect(source.listed).toEqual([]);
  });
});

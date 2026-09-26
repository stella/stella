import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { documentAstSchema } from "@stll/legal-ast/document-ast";

import {
  decodeSourceRawEnvelope,
  type IngestionResult,
  type StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { readSourceRawField } from "@/api/lib/legal-search/source-raw-field";

import {
  getAdapter,
  getSourceRegistration,
  listAdapters,
} from "../adapter-registry";
import { COURTLISTENER_SOURCE_FIELD_INVENTORY } from "./inventory";
import {
  COURTLISTENER_IMPORT_KEY,
  courtListenerTextRejectionReason,
  mapCourtListenerRecord,
  reparseStoredRaw,
} from "./map";
import {
  clusterRow,
  courtListenerRecord,
  courtRow,
  docketRow,
  opinionRow,
  recordedClusters,
} from "./test-records";

const stored = (result: IngestionResult): StoredRawReparseInput => ({
  raw: new TextEncoder().encode(result.sourceRaw),
  contentType: result.sourceRawContentType ?? null,
  caseNumber: result.caseNumber,
  sourceDocumentId: result.sourceDocumentId ?? null,
  language: result.language,
  court: result.court,
  ecli: null,
  decisionDate: result.decisionDate ?? null,
  decisionType: result.decisionType ?? null,
  sourceUrl: result.sourceUrl ?? null,
  documentUrl: result.documentUrl ?? null,
  metadata: result.metadata,
});

describe("complete CourtListener import mapping", () => {
  test("a short order maps completely and replay is a fixed point", () => {
    const input = courtListenerRecord({
      cluster: clusterRow({
        headmatter: "<p>Caption</p>",
        headnotes: "<p>Headnote</p>",
        syllabus: "Syllabus",
        summary: "Summary",
      }),
    });
    const result = mapCourtListenerRecord(input).unwrap();
    expect(result.decisionType).toBe("order");
    expect(result.sourceDocumentId).toBe("9114912");
    expect(result.courtId).toBe("scotus");
    expect(result.fulltext).toContain("Caption");
    expect(result.fulltext).toContain("Certiorari denied.");
    expect(result.textFields).toMatchObject({
      headnote: { type: "present", text: "Headnote" },
      abstract: { type: "present", text: "Syllabus" },
    });
    expect(v.is(documentAstSchema, result.documentAst)).toBe(true);
    expect(result.sections?.map(({ index }) => index)).toEqual(
      result.sections?.map((_, index) => index),
    );
    expect(reparseStoredRaw(stored(result))).toEqual({
      type: "parsed",
      result,
    });
  });
  test("recorded eligible clusters map to exact replay fixed points", () => {
    let mapped = 0;
    for (const record of recordedClusters()) {
      const outcome = mapCourtListenerRecord(record);
      if (Result.isError(outcome)) {
        expect([
          "court-not-writable",
          "requires-assets",
          "no-usable-text",
        ]).toContain(outcome.error.reason);
        continue;
      }
      mapped += 1;
      expect(v.is(documentAstSchema, outcome.value.documentAst)).toBe(true);
      expect(reparseStoredRaw(stored(outcome.value))).toEqual({
        type: "parsed",
        result: outcome.value,
      });
    }
    expect(mapped).toBeGreaterThan(0);
  });
  test("non-writable courts and image dependence reject the whole cluster", () => {
    const cases = [
      [
        courtListenerRecord({
          court: courtRow({ id: "ca9" }),
          docket: docketRow({ court_id: "ca9" }),
        }),
        "court-not-writable",
      ],
      [
        courtListenerRecord({
          opinions: [
            opinionRow({
              xml_harvard:
                '<opinion><p>Figure</p><img src="diagram.png"/></opinion>',
            }),
          ],
        }),
        "requires-assets",
      ],
    ] as const;
    for (const [input, reason] of cases) {
      const result = mapCourtListenerRecord(input);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) expect(result.error.reason).toBe(reason);
    }
  });
  test("replay refuses a changed record identity, court, language, or unsupported raw", () => {
    const row = stored(mapCourtListenerRecord(courtListenerRecord()).unwrap());
    for (const mutation of [
      { sourceDocumentId: "123" },
      { language: "de" },
      { court: "Different court" },
    ]) {
      expect(reparseStoredRaw({ ...row, ...mutation })).toMatchObject({
        type: "rejected",
        rejection: "identity-mismatch",
      });
    }
    expect(
      reparseStoredRaw({
        ...row,
        raw: new TextEncoder().encode("not an envelope"),
      }),
    ).toMatchObject({ type: "rejected", rejection: "unsupported-content" });
    expect(
      reparseStoredRaw({ ...row, raw: new Uint8Array([0xff]) }),
    ).toMatchObject({ type: "rejected", rejection: "raw-fidelity-lost" });
  });
  test("raw paths retain exact alternate columns, including control characters", () => {
    const record = courtListenerRecord({
      opinions: [opinionRow({ plain_text: "\u0000unselected\u200btext" })],
    });
    const result = mapCourtListenerRecord(record).unwrap();
    const parts = decodeSourceRawEnvelope(result.sourceRaw ?? "") ?? {};
    const disposition =
      COURTLISTENER_SOURCE_FIELD_INVENTORY.fields["opinions[].plain_text"];
    expect(disposition?.disposition).toBe("stored");
    if (
      disposition?.disposition !== "stored" ||
      disposition.target.type !== "raw"
    )
      throw new Error("Expected raw field target");
    expect(readSourceRawField(parts, disposition.target)).toEqual([
      record.opinions[0]?.plain_text,
    ]);
    expect(
      readSourceRawField(parts, {
        ...disposition.target,
        path: ["*", "missing"],
      }),
    ).toEqual([undefined]);
  });
  test("opinion order changes neither canonical document nor content fingerprint", () => {
    const first = opinionRow();
    const second = opinionRow({
      id: "9109420",
      type: "040dissent",
      xml_harvard: '<opinion type="dissent"><p>I dissent.</p></opinion>',
    });
    const a = mapCourtListenerRecord(
      courtListenerRecord({ opinions: [first, second] }),
    ).unwrap();
    const b = mapCourtListenerRecord(
      courtListenerRecord({ opinions: [second, first] }),
    ).unwrap();
    expect(a.documentAst).toEqual(b.documentAst);
    expect(a.metadata).toEqual(b.metadata);
    expect(a.rawHash).toBe(b.rawHash);
    expect(a.citationScopes).toEqual(b.citationScopes);
  });
});

test("the importer participates in conformance and replay but has no crawl capability", () => {
  const registration = getSourceRegistration(COURTLISTENER_IMPORT_KEY);
  expect(registration?.capability).toBe("import");
  expect(registration?.source.reparseStoredRaw).toBe(reparseStoredRaw);
  expect(getAdapter(COURTLISTENER_IMPORT_KEY)).toBeUndefined();
  expect(
    listAdapters().some(({ key }) => String(key) === COURTLISTENER_IMPORT_KEY),
  ).toBe(false);
  expect(registration?.source).not.toHaveProperty("fetchPage");
  expect(registration?.source).not.toHaveProperty("reconciliation");
});

test("parser scope defects remain distinct from missing or unsupported source text", () => {
  expect(
    courtListenerTextRejectionReason({
      status: "scope-defect",
      defect: "duplicate-block-id",
      opinions: [],
    }),
  ).toBe("scope-defect");
  expect(
    courtListenerTextRejectionReason({
      status: "held",
      reason: "no-usable-text",
      opinions: [],
    }),
  ).toBe("no-usable-text");
  expect(
    courtListenerTextRejectionReason({ status: "unsupported", opinions: [] }),
  ).toBe("no-usable-text");
});

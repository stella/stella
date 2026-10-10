import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { documentAstSchema } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { toPlainTextMetadata } from "@/api/lib/case-law/plain-text";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
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
  opinionRow,
  recordedClusters,
} from "./test-records";
import { OPINION_TYPES } from "./vocabulary";

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
  test("a rejected label returns a typed cluster rejection while other records map", () => {
    const bad = mapCourtListenerRecord(
      courtListenerRecord({
        cluster: clusterRow({ case_name: "\\par broken" }),
      }),
    );
    expect(bad.isErr()).toBe(true);
    if (bad.isErr()) {
      expect(bad.error).toMatchObject({
        reason: "plain-text-rejected",
        sourceRecordKey: "cluster:9114912",
        clusterId: "9114912",
        diagnostics: [{ path: "labels-or-metadata", detail: "rtf-syntax" }],
      });
    }
    expect(mapCourtListenerRecord(courtListenerRecord()).isOk()).toBe(true);
  });

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
    expect(result.decisionType).toBeUndefined();
    expect(result.metadata["decisionType"]).toEqual(
      toPlainTextMetadata({
        status: "not-stated",
        asPublished: null,
        reason: "source-does-not-state-decision-type",
      }).unwrap(),
    );
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
    expect(
      reparseStoredRaw({ ...stored(result), decisionType: "opinion" }),
    ).toEqual({
      type: "parsed",
      result,
    });
  });
  test("recorded eligible clusters map to exact replay fixed points", () => {
    let mapped = 0;
    for (const record of recordedClusters()) {
      const outcome = mapCourtListenerRecord(record);
      if (Result.isError(outcome)) {
        expect(["requires-assets", "no-usable-text"]).toContain(
          outcome.error.reason,
        );
        continue;
      }
      mapped += 1;
      expect(v.is(documentAstSchema, outcome.value.documentAst)).toBe(true);
      expect(outcome.value.decisionType).toBeUndefined();
      expect(outcome.value.metadata["decisionType"]).toEqual(
        toPlainTextMetadata({
          status: "not-stated",
          asPublished: null,
          reason: "source-does-not-state-decision-type",
        }).unwrap(),
      );
      expect(outcome.value.metadata["structure"]).toMatchObject({
        principalLength: expect.any(Number),
        bodyParagraphCount: expect.any(Number),
        inBodyCitationCount: { status: "counted", count: expect.any(Number) },
        opinionTypes: expect.any(Array),
        scdbPresent: expect.any(Boolean),
      });
      expect(reparseStoredRaw(stored(outcome.value))).toEqual({
        type: "parsed",
        result: outcome.value,
      });
    }
    expect(mapped).toBeGreaterThan(0);
  });
  test("image dependence rejects the whole cluster", () => {
    const cases = [
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
      if (Result.isError(result)) {
        expect(result.error.reason).toBe(reason);
      }
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
    ) {
      throw new Error("Expected raw field target");
    }
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
  const crawlAdapterKeys: readonly string[] = listAdapters().map(
    ({ key }) => key,
  );
  expect(crawlAdapterKeys).not.toContain(COURTLISTENER_IMPORT_KEY);
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
});

test("CourtListener source types and text never infer a decision type", () => {
  assertProperty(
    "CourtListener source types and text never infer a decision type",
    fc.property(
      fc.constantFrom(...Object.keys(OPINION_TYPES)),
      fc.constantFrom(
        "Certiorari denied.",
        "ORDER",
        "The court explains its reasons.",
        "Judgment affirmed.",
        "OPINION",
      ),
      fc.integer({ min: 1, max: 20 }),
      fc.boolean(),
      (type, text, paragraphs, scdb) => {
        const record = courtListenerRecord({
          cluster: clusterRow({ scdb_id: scdb ? "1991-001" : "" }),
          opinions: [
            opinionRow({
              type,
              xml_harvard: `<opinion type="majority">${Array.from({ length: paragraphs }, () => `<p>${text}</p>`).join("")}</opinion>`,
            }),
          ],
        });
        const result = mapCourtListenerRecord(record).unwrap();
        expect(result.decisionType).toBeUndefined();
        const sanitized = sanitizeResult(result);
        expect(sanitized.decisionType).toBeUndefined();
        expect(sanitized.metadata["decisionType"]).toEqual(
          result.metadata["decisionType"],
        );
        expect(result.documentAst.metadata.decisionType).toBeNull();
        expect(result.metadata["decisionType"]).toEqual(
          toPlainTextMetadata({
            status: "not-stated",
            asPublished: null,
            reason: "source-does-not-state-decision-type",
          }).unwrap(),
        );
        expect(result.metadata).not.toHaveProperty("classification");
        expect(result.metadata["structure"]).toMatchObject({
          opinionTypes: [type],
          scdbPresent: scdb,
        });
        expect(
          mapCourtListenerRecord(record).unwrap().metadata["structure"],
        ).toEqual(result.metadata["structure"]);
      },
    ),
    { numRuns: 60 },
  );
});

test("principal structure counts exclude separate opinions and apparatus", () => {
  const result = mapCourtListenerRecord(
    courtListenerRecord({
      cluster: clusterRow({ scdb_id: "1991-001" }),
      opinions: [
        opinionRow({
          xml_harvard:
            '<casebody><headnotes><p>Publisher: 500 U.S. 1.</p></headnotes><opinion type="majority"><p>First: 410 U.S. 113.</p><p>Second: Id. at 120.</p><footnote label="1"><p>Note: 500 U.S. 1.</p></footnote><opinion type="dissent"><p>Separate: 500 U.S. 1.</p></opinion></opinion></casebody>',
        }),
      ],
    }),
  ).unwrap();
  expect(result.metadata["structure"]).toEqual(
    toPlainTextMetadata({
      principalLength: "First: 410 U.S. 113. Second: Id. at 120.".length,
      bodyParagraphCount: 2,
      inBodyCitationCount: { status: "counted", count: 2 },
      opinionTypes: ["020lead"],
      scdbPresent: true,
    }).unwrap(),
  );
});

test("recorded CourtListener fixtures preserve unstated types and deterministic structure", () => {
  assertProperty(
    "recorded CourtListener fixtures preserve unstated types and deterministic structure",
    fc.property(
      fc.constantFrom(...recordedClusters()),
      fc.boolean(),
      fc.option(fc.string(), { nil: null }),
      (record, reverse, storedDecisionType) => {
        const input = {
          ...record,
          opinions: reverse ? record.opinions.toReversed() : record.opinions,
        };
        const result = mapCourtListenerRecord(input);
        if (Result.isError(result)) {
          expect(["requires-assets", "no-usable-text"]).toContain(
            result.error.reason,
          );
          return;
        }
        expect(result.value.decisionType).toBeUndefined();
        expect(result.value.metadata["decisionType"]).toEqual(
          toPlainTextMetadata({
            status: "not-stated",
            asPublished: null,
            reason: "source-does-not-state-decision-type",
          }).unwrap(),
        );
        expect(result.value.metadata["structure"]).toMatchObject({
          principalLength: expect.any(Number),
          bodyParagraphCount: expect.any(Number),
          inBodyCitationCount: { status: "counted", count: expect.any(Number) },
          opinionTypes: expect.any(Array),
          scdbPresent: expect.any(Boolean),
        });
        const replay = reparseStoredRaw({
          ...stored(result.value),
          decisionType: storedDecisionType,
        });
        expect(replay).toEqual({ type: "parsed", result: result.value });
      },
    ),
    { numRuns: 30 },
  );
});

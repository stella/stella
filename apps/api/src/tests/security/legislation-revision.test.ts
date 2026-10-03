import { expect, expectTypeOf, test } from "bun:test";

import { LegislationRevision } from "@/api/handlers/legislation/revision";
import type { LegislationRevisionProjection } from "@/api/handlers/legislation/revision";
import { createSafeId } from "@/api/lib/branded-types";
import { sanitizeMetadata } from "@/api/lib/legal-search/corpus-sanitize";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";

const classification = {
  expressionKind: "unversioned",
  windowDisposition: "effective",
  windowDispositionBasis: null,
} as const;

const fetched = {
  sourceId: createSafeId<"legislationSource">(),
  eli: "revision-test",
  title: "First revision",
  country: "CZE",
  language: "cs",
  version: { type: "unversioned" },
  fulltext: "First text",
  metadata: { revision: "first" },
  rawHash: "first",
} satisfies LegislationDocumentInput;

const sourceRaw = { sourceRawS3Key: null, sourceRawContentType: null };

test("revision writers reject separately assembled metadata and body", async () => {
  const first = new LegislationRevision(fetched);
  const second = new LegislationRevision({
    ...fetched,
    title: "Second revision",
    fulltext: "Second text",
    rawHash: "second",
  });
  const mixedRevision = {
    input: first.input,
    window: first.window,
    payload: second.payload,
    contentHash: first.contentHash,
  };
  expectTypeOf(mixedRevision).not.toExtend<LegislationRevision>();
  expect(mixedRevision).not.toBeInstanceOf(LegislationRevision);

  const firstProjection = first.withoutCorpusWrite(classification);
  const secondProjection = second.withoutCorpusWrite(classification);
  const mixedProjection = {
    sourceHash: firstProjection.sourceHash,
    outcome: secondProjection.outcome,
  };
  expectTypeOf(mixedProjection).not.toExtend<LegislationRevisionProjection>();
  expect(mixedProjection.sourceHash).not.toBe(secondProjection.sourceHash);

  const writeInputs: string[] = [];
  await second.writeCorpus({
    documentId: "revision-test",
    stored: null,
    classification,
    write: async (input) => {
      writeInputs.push(input.text ?? "");
      const plan = planCorpusDocumentWrite(input);
      if (plan.type === "put") {
        return { type: "written", written: plan.written };
      }
      return plan;
    },
  });
  expect(writeInputs).toEqual([second.values(sourceRaw).fulltext ?? ""]);
});

test("caller mutations cannot change a captured revision", () => {
  const raw = structuredClone(fetched);
  const revision = new LegislationRevision(raw);
  const before = revision.sourceHash(classification);
  raw.fulltext = "Changed by caller";
  raw.metadata.revision = "changed";
  const read = revision.input;
  read.fulltext = "Changed through getter";
  expect(revision.sourceHash(classification)).toBe(before);
  expect(revision.values(sourceRaw).fulltext).toBe(fetched.fulltext);
  expect(revision.values(sourceRaw).metadata).toEqual(fetched.metadata);
});

test("non-cloneable metadata values are sanitized instead of aborting the revision", () => {
  const metadata = {
    kept: "value",
    callback: () => "not data",
    marker: Symbol("not data"),
    pending: Promise.resolve("not data"),
    nested: { callback: () => "not data" },
  };
  const revision = new LegislationRevision({ ...fetched, metadata });
  expect(revision.input.metadata).toEqual(sanitizeMetadata(metadata));
  expect(revision.input.metadata).toMatchObject({
    kept: "value",
    callback: null,
    marker: null,
    nested: { callback: null },
  });
});

import { expect, test } from "bun:test";

import { LegislationRevision } from "@/api/handlers/legislation/revision";
import { toSafeId } from "@/api/lib/branded-types";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";

const input = {
  sourceId: toSafeId<"legislationSource">(
    "0198e331-e578-7000-8000-000000000f01",
  ),
  eli: "publisher:work:one",
  title: "A published act",
  country: "EU",
  language: "en",
  status: "unknown",
  version: {
    type: "consolidation",
    validFrom: "2020-01-01",
    end: { type: "open" },
  },
  expression: { publisherId: "publisher:expression:one" },
  rawHash: "raw-observation",
  metadata: {
    publisherEvidence: {
      inForce: { status: "not-stated", locator: "work/force" },
      dates: [
        {
          meaning: { type: "entry-into-force" },
          lexicalValue: "2020-01-01",
          normalizedDate: "2020-01-01",
          scope: { type: "work" },
          locator: "work/date/EV",
        },
        {
          meaning: { type: "applicability" },
          lexicalValue: "2021-01-01",
          normalizedDate: "2021-01-01",
          scope: { type: "provision", rawLocator: "AR 3" },
          locator: "work/date/MA",
          annotation: "Article 3",
        },
        {
          meaning: { type: "other", publisherCode: "source-sentinel" },
          lexicalValue: "9999-12-31",
          normalizedDate: null,
          scope: { type: "work" },
          locator: "work/end",
        },
      ],
    },
  },
} as const satisfies LegislationDocumentInput;

test("work aliases change the revision fingerprint, independent of alias ordering and duplicates", () => {
  const original = new LegislationRevision(input);
  const a = new LegislationRevision({
    ...input,
    identifiers: ["alias:a", "alias:b"],
  });
  const b = new LegislationRevision({
    ...input,
    identifiers: ["alias:b", "alias:a", "alias:a"],
  });
  expect(a.sourceHash(EFFECTIVE_CONSOLIDATION)).not.toBe(
    original.sourceHash(EFFECTIVE_CONSOLIDATION),
  );
  expect(a.sourceHash(EFFECTIVE_CONSOLIDATION)).toBe(
    b.sourceHash(EFFECTIVE_CONSOLIDATION),
  );
});

test("a revision retains independent date meanings, provision scope and an unnormalized sentinel", () => {
  const revision = new LegislationRevision(input);
  const stored = revision.values({
    sourceRawS3Key: null,
    sourceRawContentType: null,
  });
  expect(stored.metadata.publisherEvidence).toEqual(
    input.metadata.publisherEvidence,
  );
  expect(stored.status).toBe("unknown");
  const changed = structuredClone(input);
  const corrected = new LegislationRevision({
    ...changed,
    metadata: {
      publisherEvidence: {
        ...changed.metadata.publisherEvidence,
        inForce: { status: "stated", value: true, locator: "work/force" },
      },
    },
  });
  expect(corrected.sourceHash(EFFECTIVE_CONSOLIDATION)).not.toBe(
    revision.sourceHash(EFFECTIVE_CONSOLIDATION),
  );
  expect(revision.input.metadata?.publisherEvidence).toEqual(
    input.metadata.publisherEvidence,
  );
});

import { expect, expectTypeOf, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { CollisionFilteredDecisions } from "@/api/handlers/case-law/ingestion/quarantine-collision-filter";
import {
  type CollisionRetainedDecisions,
  createQuarantineCollisionRetention,
  type FlushedListingPage,
} from "@/api/handlers/case-law/ingestion/quarantine-collision-retention";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  LISTING_OBSERVATION_REASON,
  QUARANTINE_NAMESPACE,
  type QuarantineCollisionObservation,
  quarantineIdentity,
} from "@/api/lib/legal-search/quarantine-identity";

const { sourceDocumentId } = quarantineIdentity({
  namespace: QUARANTINE_NAMESPACE.CZ_NS,
  stableFields: { docket: "21 Cdo 1/2026" },
});

type EvidenceDecisionOptions = { raw: string | undefined; astId: string };

const decision = ({ raw, astId }: EvidenceDecisionOptions) =>
  plainTextIngestionResult({
    caseNumber: "21 Cdo 1/2026",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    sourceDocumentId,
    metadata: { publisherLabel: "Published listing" },
    fulltext: "Published decision text.",
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    sourceRaw: raw,
    rawHash: `derived-${astId}`,
    parserVersion: astId.length,
    documentAst: {
      version: 1,
      source: {
        system: "test",
        documentId: sourceDocumentId,
        webUrl: "",
        printUrl: "",
      },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [
        {
          id: astId,
          anchorId: astId,
          type: "paragraph",
          inlines: [{ type: "text", text: "Published decision text." }],
          plainText: "Published decision text.",
        },
      ],
    },
  });

test.each([undefined, "<article>Published decision text.</article>"])(
  "reparsing publisher evidence %s retains one immutable revision",
  async (raw) => {
    const evidence: QuarantineCollisionObservation[] = [];
    const retention = createQuarantineCollisionRetention({
      adapterKey: "cz-ns",
      persistEvidence: async (observations) => {
        evidence.push(
          ...observations.map((observation) => {
            if (
              observation.reason !==
              LISTING_OBSERVATION_REASON.QUARANTINE_COLLISION
            ) {
              expect.unreachable(
                "Only collision evidence is expected in this case",
              );
            }
            return observation;
          }),
        );
      },
    });
    const first = decision({ raw, astId: "first" });
    const reparsed = decision({ raw, astId: "different-parser-block-id" });
    const retained = await retention.retainDecisions({
      type: "crawl",
      observations: [],
      decisions: [first, reparsed],
      proof: { type: "no-listing-proof" },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.payload.record).toMatchObject({
      metadata: first.metadata,
      textFields: first.textFields,
      fulltext: first.fulltext,
    });
    expect(evidence[0]?.payload.record).not.toHaveProperty("documentAst");
    expect(evidence[0]?.payload.record).not.toHaveProperty("parserVersion");
    expect(evidence[0]?.payload.record).not.toHaveProperty("rawHash");
    expect(retained.decisions).toHaveLength(2);
    await retention.retainDecisions({
      type: "crawl",
      observations: [],
      decisions: [reparsed],
      proof: { type: "no-listing-proof" },
    });
    expect(evidence).toHaveLength(1);
    expectTypeOf<CollisionFilteredDecisions>().not.toExtend<CollisionRetainedDecisions>();
    expectTypeOf({ ...retained }).not.toExtend<CollisionRetainedDecisions>();
  },
);

test("different publisher raw revisions are durable before an apply receipt exists", async () => {
  const evidence: QuarantineCollisionObservation[] = [];
  const retention = createQuarantineCollisionRetention({
    adapterKey: "cz-ns",
    persistEvidence: async (observations) => {
      await Promise.resolve();
      evidence.push(
        ...observations.map((observation) => {
          if (
            observation.reason !==
            LISTING_OBSERVATION_REASON.QUARANTINE_COLLISION
          ) {
            expect.unreachable(
              "Only collision evidence is expected in this case",
            );
          }
          return observation;
        }),
      );
    },
  });
  const retained = await retention.retainDecisions({
    type: "crawl",
    observations: [],
    decisions: [
      decision({ raw: "first source", astId: "same" }),
      decision({ raw: "second source", astId: "same" }),
    ],
    proof: { type: "no-listing-proof" },
  });
  expect(evidence).toHaveLength(2);
  expect(evidence.map(({ payload }) => payload.record)).toEqual([
    expect.objectContaining({ sourceRaw: "first source" }),
    expect.objectContaining({ sourceRaw: "second source" }),
  ]);
  expect(retained.decisions).toHaveLength(2);
});

test("a single quarantine listing stays with its canonical retention owner", async () => {
  const evidence: QuarantineCollisionObservation[] = [];
  const retention = createQuarantineCollisionRetention({
    adapterKey: "cz-ns",
    persistEvidence: async (observations) => {
      evidence.push(
        ...observations.map((observation) => {
          if (
            observation.reason !==
            LISTING_OBSERVATION_REASON.QUARANTINE_COLLISION
          ) {
            expect.unreachable(
              "Only collision evidence is expected in this case",
            );
          }
          return observation;
        }),
      );
    },
  });
  const retained = await retention.retainDecisions({
    type: "crawl",
    observations: [],
    decisions: [decision({ raw: undefined, astId: "single" })],
    proof: { type: "no-listing-proof" },
  });
  expect(retained.decisions).toHaveLength(1);
  expect(evidence).toEqual([]);
});

test("a rejected evidence write cannot produce an apply receipt", async () => {
  const failure = new AdapterFetchError({
    adapterKey: "cz-ns",
    cursor: null,
    message: "Evidence write refused",
  });
  const retention = createQuarantineCollisionRetention({
    adapterKey: "cz-ns",
    persistEvidence: async () => {
      throw failure;
    },
  });
  expect(
    await rejectionOf(
      retention.retainDecisions({
        type: "crawl",
        observations: [],
        decisions: [
          decision({ raw: "first source", astId: "id" }),
          decision({ raw: "second source", astId: "id" }),
        ],
        proof: { type: "no-listing-proof" },
      }),
    ),
  ).toBe(failure);
});

test("only a retained page authorizes listing progress", async () => {
  const retention = createQuarantineCollisionRetention({
    adapterKey: "cz-ns",
    persistEvidence: async () => undefined,
  });
  const page = { items: [], observations: [], totalPages: 2 };
  const retained = await retention.retainPage(page, 0);
  expect(retained.page).toBe(page);
  expect(retained.nextPage).toBe(1);
  expectTypeOf(page).not.toExtend<FlushedListingPage>();
  expectTypeOf({ ...retained }).not.toExtend<FlushedListingPage>();
});

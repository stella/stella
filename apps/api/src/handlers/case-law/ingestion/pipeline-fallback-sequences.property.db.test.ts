import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionFallbackIdentities,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import { caseLawCanonicalPayload } from "@/api/lib/legal-search/decision-payload";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const OBSERVATIONS = ["textless", "weak-full", "ecli", "sheet"] as const;
const INITIAL_STATES = [
  "empty",
  "legacy-textless",
  "legacy-full",
  "legacy-unhashed-full",
] as const;
type Observation = (typeof OBSERVATIONS)[number];
const observation = (type: Observation) =>
  plainTextIngestionResult({
    caseNumber: "104 C 16/2024",
    court: "Okresní soud v Chrudimi",
    country: "CZE",
    language: "cs",
    ecli: type === "ecli" ? "ECLI:CZ:OSCR:2025:104.C.16.2024.1" : undefined,
    sheetNumber: type === "sheet" ? "28" : undefined,
    fulltext: type === "textless" ? "" : "Výrok rozhodnutí.",
    rawHash: type,
    metadata: {},
    documentAst: EMPTY_AST,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
const sequence = fc.array(fc.constantFrom(...OBSERVATIONS), {
  minLength: 2,
  maxLength: 3,
});
const exhaustiveSequences = OBSERVATIONS.flatMap((first) =>
  OBSERVATIONS.flatMap((second) => [
    [first, second],
    ...OBSERVATIONS.map((third) => [first, second, third]),
  ]),
);
const examples: [(typeof INITIAL_STATES)[number], Observation[]][] = [
  ["legacy-full", ["ecli", "weak-full"]],
  ...INITIAL_STATES.flatMap((initial) =>
    exhaustiveSequences.map(
      (steps) =>
        [initial, steps] satisfies [
          (typeof INITIAL_STATES)[number],
          Observation[],
        ],
    ),
  ),
];

test(
  "all compatible fallback observation orders preserve the original publication UUID",
  async () => {
    const client = await createTestPglite();
    const db = drizzle({
      client,
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    try {
      await assertProperty(
        "fallback publication transition sequences preserve original UUID",
        fc.asyncProperty(
          fc.constantFrom(...INITIAL_STATES),
          sequence,
          async (initial, steps) => {
            const sourceId = createSafeId<"caseLawSource">();
            await db.insert(caseLawSources).values({
              id: sourceId,
              adapterKey: `sequence-${sourceId}`,
              name: "Publication sequence fixture",
            });
            let originalId: SafeId<"caseLawDecision"> | undefined;
            let documentSeen =
              initial === "legacy-full" || initial === "legacy-unhashed-full";
            const strongKinds = new Set<Observation>();
            if (initial !== "empty") {
              const input = observation(
                documentSeen ? "weak-full" : "textless",
              );
              originalId = createSafeId<"caseLawDecision">();
              await db.insert(caseLawDecisions).values({
                ...input,
                id: originalId,
                sourceId,
                fulltext: input.fulltext || null,
                contentHash:
                  initial === "legacy-full"
                    ? corpusContentHash(caseLawCanonicalPayload(input))
                    : null,
              });
            }
            let order = 0n;
            for (const step of steps) {
              // db-await-in-loop: each observation must see the preceding committed transition.
              const outcome = await processDecision({
                input: observation(step),
                scopedDb,
                sourceId,
                corpus: {
                  mode: "off",
                  transfer: {
                    layout: "packs",
                    putPacks: () =>
                      panic("Off-mode sequences must not transfer documents"),
                  },
                },
                observationOrder: ++order,
                observedAt: new Date("2026-10-29T08:00:00Z"),
              });
              expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
              // db-await-in-loop: assert durability after every transition, not just the final state.
              const rows = await db
                .select({
                  id: caseLawDecisions.id,
                  text: caseLawDecisions.fulltext,
                  identityKey: caseLawDecisions.fallbackIdentityKey,
                  documentHash: caseLawDecisions.fallbackDocumentHash,
                  publicationHash: caseLawDecisions.fallbackPublicationHash,
                })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.sourceId, sourceId));
              expect(rows).toHaveLength(1);
              const row = rows.at(0) ?? panic("The publication disappeared");
              originalId ??= row.id;
              expect(row.id).toBe(originalId);
              documentSeen ||= step !== "textless";
              if (documentSeen) {
                expect(row.text).toBe("Výrok rozhodnutí.");
                expect(row.documentHash).not.toBeNull();
              }
              expect(row.publicationHash).not.toBeNull();
              if (step === "ecli" || step === "sheet") {
                strongKinds.add(step);
              }
              // db-await-in-loop: aliases must be durable on the original UUID after every transition.
              const aliases = await db
                .select({
                  key: caseLawDecisionFallbackIdentities.identityKey,
                  id: caseLawDecisionFallbackIdentities.decisionId,
                })
                .from(caseLawDecisionFallbackIdentities)
                .where(
                  eq(caseLawDecisionFallbackIdentities.sourceId, sourceId),
                );
              expect(aliases).toHaveLength(strongKinds.size);
              const expectedOwnerId = originalId;
              expect(
                aliases.every((alias) => alias.id === expectedOwnerId),
              ).toBe(true);
              if (row.identityKey !== null) {
                expect(
                  aliases.some((alias) => alias.key === row.identityKey),
                ).toBe(true);
              }
            }
          },
        ),
        { examples, numRuns: examples.length + 32 },
      );
    } finally {
      await client.close();
    }
  },
  propertyTestTimeout(120_000),
);

test("legacy inline fulltext without persisted proof is adopted before sibling insertion", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  const sourceId = createSafeId<"caseLawSource">();
  const originalId = createSafeId<"caseLawDecision">();
  const input = observation("weak-full");
  const ingest = async (fulltext: string, observationOrder: bigint) =>
    await processDecision({
      input: plainTextIngestionResult({
        ...input,
        fulltext,
        rawHash: fulltext,
      }),
      scopedDb,
      sourceId,
      corpus: {
        mode: "off",
        transfer: {
          layout: "packs",
          putPacks: () => panic("Inline fixture must not transfer documents"),
        },
      },
      observationOrder,
      observedAt: new Date("2026-10-29T08:00:00Z"),
    });
  const stored = async () =>
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `legacy-${sourceId}`,
      name: "Legacy inline fixture",
    });
    // Recreate the expansion constraint only inside this isolated contract fixture.
    await db.execute(sql`CREATE UNIQUE INDEX case_law_decisions_source_case_lang_null_idx
      ON case_law_decisions (source_id, case_number, language) WHERE source_document_id IS NULL`);
    await db
      .insert(caseLawDecisions)
      .values({ ...input, id: originalId, sourceId, contentHash: null });
    const before = (await stored()).at(0) ?? panic("Legacy row missing");
    expect(before.fulltext).toBe("Výrok rozhodnutí.");
    expect(before.contentHash).toBeNull();
    expect(before.fallbackIdentityKey).toBeNull();
    expect(before.fallbackCohortKey).toBeNull();
    expect(before.fallbackPublicationHash).toBeNull();
    expect(before.fallbackContentHash).toBeNull();
    expect(before.fallbackDocumentHash).toBeNull();
    // Keep the old unique index: an accidental insert must fail here.
    expect((await ingest(input.fulltext ?? "", 1n)).status).toBe(
      PROCESS_DECISION_STATUS.COMPLETE,
    );
    const adopted = await stored();
    expect(adopted).toHaveLength(1);
    const row = adopted.at(0) ?? panic("Adopted row missing");
    expect(row.id).toBe(originalId);
    expect(row.fallbackIdentityKey).toBeNull();
    expect(row.fallbackCohortKey).not.toBeNull();
    expect(row.fallbackPublicationHash).not.toBeNull();
    expect(row.fallbackContentHash).not.toBeNull();
    expect(row.fallbackDocumentHash).toBe(
      corpusContentHash(caseLawCanonicalPayload(input)),
    );
    // Different weak documents are siblings once the contract release removes the docket index.
    await db.execute(
      sql`DROP INDEX case_law_decisions_source_case_lang_null_idx`,
    );
    expect((await ingest("Výrok druhého rozhodnutí.", 2n)).status).toBe(
      PROCESS_DECISION_STATUS.COMPLETE,
    );
    const siblings = await stored();
    expect(siblings).toHaveLength(2);
    expect(siblings.find(({ id }) => id === originalId)?.fulltext).toBe(
      input.fulltext,
    );
    expect(
      siblings.find(({ fulltext }) => fulltext === "Výrok druhého rozhodnutí.")
        ?.id,
    ).not.toBe(originalId);
  } finally {
    await client.close();
  }
});

const SIBLING_KINDS = ["same-text-conflicting-ecli", "different-text"] as const;
const siblingSequences = [0, 1].flatMap((first) =>
  [0, 1].flatMap((second) => [
    [first, second],
    ...[0, 1].map((third) => [first, second, third]),
  ]),
);
const SIBLING_STARTS = [
  "empty",
  "legacy-full",
  "legacy-unhashed-full",
] as const;
const siblingExamples: [
  (typeof SIBLING_KINDS)[number],
  (typeof SIBLING_STARTS)[number],
  number[],
][] = SIBLING_KINDS.flatMap((kind) =>
  SIBLING_STARTS.flatMap((legacy) =>
    siblingSequences.map(
      (steps) =>
        [kind, legacy, steps] satisfies [
          (typeof SIBLING_KINDS)[number],
          (typeof SIBLING_STARTS)[number],
          number[],
        ],
    ),
  ),
);

test(
  "generated fallback sequences preserve contradictory and different-document siblings",
  async () => {
    const client = await createTestPglite();
    const db = drizzle({
      client,
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    try {
      await assertProperty(
        "fallback sibling transition sequences preserve each decision",
        fc.asyncProperty(
          fc.constantFrom(...SIBLING_KINDS),
          fc.constantFrom(...SIBLING_STARTS),
          fc.array(fc.integer({ min: 0, max: 1 }), {
            minLength: 2,
            maxLength: 3,
          }),
          async (kind, legacy, steps) => {
            const sourceId = createSafeId<"caseLawSource">();
            await db.insert(caseLawSources).values({
              id: sourceId,
              adapterKey: `siblings-${sourceId}`,
              name: "Sibling sequence fixture",
            });
            const first = observation(
              kind === "different-text" ? "weak-full" : "ecli",
            );
            const second = plainTextIngestionResult({
              ...first,
              fulltext:
                kind === "different-text"
                  ? "Výrok druhého rozhodnutí."
                  : first.fulltext,
              ecli:
                kind === "different-text"
                  ? undefined
                  : "ECLI:CZ:OSCR:2025:104.C.16.2024.2",
              rawHash: "second-publication",
            });
            const publications = [first, second];
            const ids = new Map<number, SafeId<"caseLawDecision">>();
            if (legacy !== "empty") {
              const id = createSafeId<"caseLawDecision">();
              await db.insert(caseLawDecisions).values({
                ...first,
                id,
                sourceId,
                contentHash:
                  legacy === "legacy-full"
                    ? corpusContentHash(caseLawCanonicalPayload(first))
                    : null,
              });
              ids.set(0, id);
            }
            let order = 0n;
            for (const step of steps) {
              const input =
                publications.at(step) ??
                panic("Generated publication index is invalid");
              // db-await-in-loop: observations and their invariants require committed sequence order.
              const outcome = await processDecision({
                input,
                scopedDb,
                sourceId,
                corpus: {
                  mode: "off",
                  transfer: {
                    layout: "packs",
                    putPacks: () =>
                      panic("Off-mode sequences must not transfer documents"),
                  },
                },
                observationOrder: ++order,
                observedAt: new Date("2026-10-29T08:00:00Z"),
              });
              expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
              // db-await-in-loop: inspect every persisted intermediate state.
              const rows = await db
                .select({
                  id: caseLawDecisions.id,
                  text: caseLawDecisions.fulltext,
                  ecli: caseLawDecisions.ecli,
                })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.sourceId, sourceId));
              const row =
                rows.find((candidate) =>
                  kind === "different-text"
                    ? candidate.text === input.fulltext
                    : candidate.ecli === input.ecli,
                ) ?? panic("A stated sibling was lost");
              const previous = ids.get(step);
              if (previous === undefined) {
                ids.set(step, row.id);
              } else {
                expect(row.id).toBe(previous);
              }
              expect(rows).toHaveLength(ids.size);
              expect(new Set(rows.map((candidate) => candidate.id)).size).toBe(
                ids.size,
              );
              for (const [member, id] of ids) {
                const published =
                  publications.at(member) ?? panic("Missing published member");
                expect(
                  rows.find((candidate) => candidate.id === id)?.text,
                ).toBe(published.fulltext);
              }
            }
          },
        ),
        { examples: siblingExamples, numRuns: siblingExamples.length + 32 },
      );
    } finally {
      await client.close();
    }
  },
  propertyTestTimeout(120_000),
);

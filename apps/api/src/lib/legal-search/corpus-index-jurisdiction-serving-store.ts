/**
 * Which generation serves a jurisdiction when it is not the family's serving
 * generation.
 *
 * A row exists only after the gated flip (`case-law-serving-flip.ts`) or a
 * fallback that keeps a jurisdiction on the newer generation
 * (`corpus-index-fallback-policy.ts`, applied by the serving mutation);
 * without one a jurisdiction is served by the family's serving generation,
 * which is the routing every generation has. Every path that resolves a jurisdiction to an
 * index or to the generation whose projection state accepts a hit reads this
 * and nothing else (`corpus-index-jurisdiction-serving.guard.test.ts`).
 */
import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { corpusIndexJurisdictionServing } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

type ReadTransaction = Pick<Transaction, "select">;

/** More jurisdictions than a family declares; the read is bounded by it. */
const SERVING_ROWS_MAX = 64;

/** Jurisdiction (canonical uppercase) to the generation that serves it. */
export type JurisdictionServingGenerations = ReadonlyMap<string, string>;

export const readJurisdictionServingGenerationsTx = async (
  tx: ReadTransaction,
  family: CorpusFamily,
): Promise<JurisdictionServingGenerations> => {
  const read = await readBounded(
    tx
      .select({
        jurisdiction: corpusIndexJurisdictionServing.jurisdiction,
        generation: corpusIndexJurisdictionServing.generation,
      })
      .from(corpusIndexJurisdictionServing)
      .where(eq(corpusIndexJurisdictionServing.family, family)),
    SERVING_ROWS_MAX,
  );
  if (read.type === "overflow") {
    // One row per jurisdiction: more than a family declares cannot exist.
    return panic("A family holds more serving pointers than jurisdictions", {
      family,
      cap: read.cap,
    });
  }
  return new Map(
    read.rows.map(({ jurisdiction, generation }) => [jurisdiction, generation]),
  );
};

/** One pointer row: who serves the jurisdiction, and whom it was moved from. */
export type JurisdictionServingPointer = {
  jurisdiction: string;
  generation: string;
  fromGeneration: string;
};

/** Every pointer of a family, with the generation each was moved from. */
export const readJurisdictionServingPointersTx = async (
  tx: ReadTransaction,
  family: CorpusFamily,
): Promise<readonly JurisdictionServingPointer[]> => {
  const read = await readBounded(
    tx
      .select({
        jurisdiction: corpusIndexJurisdictionServing.jurisdiction,
        generation: corpusIndexJurisdictionServing.generation,
        fromGeneration: corpusIndexJurisdictionServing.fromGeneration,
      })
      .from(corpusIndexJurisdictionServing)
      .where(eq(corpusIndexJurisdictionServing.family, family))
      .orderBy(corpusIndexJurisdictionServing.jurisdiction),
    SERVING_ROWS_MAX,
  );
  return read.type === "overflow"
    ? panic("A family holds more serving pointers than jurisdictions", {
        family,
        cap: read.cap,
      })
    : read.rows;
};

/**
 * The generation each of these jurisdictions was flipped away from, for those
 * that were. One primary-key probe set for a page of decisions, shared by the
 * lock read, the batched material read and the bootstrap.
 */
export const readCaseLawJurisdictionVacatedTx = async (
  tx: ReadTransaction,
  jurisdictions: readonly string[],
): Promise<JurisdictionServingGenerations> => {
  const distinct = [...new Set(jurisdictions)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      jurisdiction: corpusIndexJurisdictionServing.jurisdiction,
      generation: corpusIndexJurisdictionServing.fromGeneration,
    })
    .from(corpusIndexJurisdictionServing)
    .where(
      and(
        eq(corpusIndexJurisdictionServing.family, "case_law"),
        inArray(corpusIndexJurisdictionServing.jurisdiction, distinct),
      ),
    )
    .limit(distinct.length);
  return new Map(
    rows.map(({ jurisdiction, generation }) => [jurisdiction, generation]),
  );
};

/**
 * Return every jurisdiction of a family to the serving generation, because a
 * whole generation that holds them all is being promoted. Audited in the
 * promotion's transaction: each returned jurisdiction is a demotion of the
 * generation it was flipped to.
 */
export const clearJurisdictionServingTx = async (
  tx: Transaction,
  family: CorpusFamily,
): Promise<number> => {
  const cleared = await tx
    .delete(corpusIndexJurisdictionServing)
    .where(eq(corpusIndexJurisdictionServing.family, family))
    .returning({ jurisdiction: corpusIndexJurisdictionServing.jurisdiction });
  await recordSystemAudit(tx, "system:corpus-generation-operator", {
    subject: createSafeId<"systemScriptRun">(),
    counts: { registered: 0, promoted: 0, demoted: cleared.length },
  });
  return cleared.length;
};

/**
 * Keep `jurisdictions` on `generation` while `fromGeneration` serves their
 * family again: a fallback under a recorded policy
 * (`corpus-index-fallback-policy.ts`). Called by the serving mutation only,
 * after it cleared every pointer and promoted `fromGeneration`, in its
 * transaction; audited there as one promotion per kept jurisdiction.
 */
export const keepJurisdictionsOnGenerationTx = async (
  tx: Transaction,
  {
    family,
    jurisdictions,
    generation,
    fromGeneration,
  }: {
    family: CorpusFamily;
    jurisdictions: readonly string[];
    generation: string;
    fromGeneration: string;
  },
): Promise<void> => {
  if (jurisdictions.length === 0) {
    return;
  }
  await tx.insert(corpusIndexJurisdictionServing).values(
    jurisdictions.map((jurisdiction) => ({
      family,
      jurisdiction,
      generation,
      fromGeneration,
    })),
  );
  await recordSystemAudit(tx, "system:corpus-generation-operator", {
    subject: createSafeId<"systemScriptRun">(),
    counts: { registered: 0, promoted: jurisdictions.length, demoted: 0 },
  });
};

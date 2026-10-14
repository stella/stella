/**
 * The scoped, resumable walk that gives a building target its desired state.
 *
 * A completed bootstrap sweep or reconciliation cursor does not restart
 * because a building target appeared, so nothing would ever project the
 * decisions of a partial generation's jurisdictions into it.
 * `rewalkBuildingTargetBatchTx` is the entry point Plane calls for that: it
 * walks only the decisions of the jurisdictions the target holds (Czech
 * decisions for `case_law_v9`), in id order from a cursor the caller owns, and
 * creates the target's desired state where it has none.
 *
 * Idempotent: a decision that already has a desired state in the target is
 * left exactly as it is, and a rerun over a walked range writes nothing. It
 * writes only the target's own rows: the desired state, fingerprints and
 * epochs of every other generation and of every other country are never read
 * for update, let alone written. A changed decision reaches the target through
 * the canonical mutation path, as it reaches every generation.
 *
 * `dry_run` reads the same page and reports what `apply` would write.
 */
import { panic } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, corpusIndexProjectionStates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  corpusIndexManifestIsPartial,
  corpusIndexManifestScopeJurisdictions,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";

const REWALK_BATCH_MAX = 500;

export type BuildingTargetRewalkOptions = {
  /** The partial generation being built, e.g. `case_law_v9`. */
  generation: string;
  /** The last decision walked; null for the first page. */
  afterEntityId: SafeId<"caseLawDecision"> | null;
  limit: number;
  /** `dry_run` writes nothing and reports the counts `apply` would write. */
  mode: "dry_run" | "apply";
};

export type BuildingTargetRewalkPage = {
  mode: BuildingTargetRewalkOptions["mode"];
  /** Decisions of the target's jurisdictions this page covers. */
  inspected: number;
  /** Desired states created (apply) or that would be created (dry run). */
  seeded: number;
  /** Decisions that already had a desired state and were left alone. */
  alreadySeeded: number;
  /** Where the next page resumes; null when the walk is complete. */
  nextAfterEntityId: SafeId<"caseLawDecision"> | null;
};

/**
 * One page of the walk. The caller loops, feeding `nextAfterEntityId` back,
 * until it is null; a page that meets rows another worker owns reports fewer
 * `seeded` than `inspected - alreadySeeded`, and a later pass finishes them.
 */
export const rewalkBuildingTargetBatchTx = async (
  tx: Transaction,
  { generation, afterEntityId, limit, mode }: BuildingTargetRewalkOptions,
): Promise<BuildingTargetRewalkPage> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REWALK_BATCH_MAX) {
    return panic(`Rewalk batch size must be 1..${String(REWALK_BATCH_MAX)}`);
  }
  const manifest = requireCorpusIndexManifest("case_law", generation);
  const scope = corpusIndexManifestScopeJurisdictions(manifest);
  if (!corpusIndexManifestIsPartial(manifest) || scope === null) {
    return panic(
      `${generation} is not a partial generation: its desired state is seeded by the bootstrap sweep`,
    );
  }

  // The page, read the same way in both modes: the target's decisions after
  // the cursor, and which of them already carry a desired state in it.
  const page = await tx
    .select({
      id: caseLawDecisions.id,
      seeded: sql<boolean>`${corpusIndexProjectionStates.entityId} IS NOT NULL`,
    })
    .from(caseLawDecisions)
    .leftJoin(
      corpusIndexProjectionStates,
      and(
        eq(corpusIndexProjectionStates.family, "case_law"),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, caseLawDecisions.id),
      ),
    )
    .where(
      and(
        inArray(caseLawDecisions.country, [...scope]),
        afterEntityId === null
          ? undefined
          : gt(caseLawDecisions.id, afterEntityId),
      ),
    )
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit);
  const unseeded = page.filter(({ seeded }) => !seeded).length;
  const nextAfterEntityId =
    page.length < limit ? null : (page.at(-1)?.id ?? null);
  const counts = {
    mode,
    inspected: page.length,
    alreadySeeded: page.length - unseeded,
    nextAfterEntityId,
  } as const;
  if (mode === "dry_run" || unseeded === 0) {
    return { ...counts, seeded: mode === "dry_run" ? unseeded : 0 };
  }

  // The bootstrap's own page is the same id range, scoped to the target's
  // jurisdictions, so it claims and seeds exactly the decisions without a
  // desired state and touches no other row.
  const seeded = await bootstrapCorpusProjectionDesiredStateBatchTx(tx, {
    family: "case_law",
    generation,
    limit,
    seedLimit: limit,
    ...(afterEntityId === null ? {} : { afterEntityId }),
  });
  return {
    ...counts,
    seeded: seeded.status === "advanced" ? seeded.seededCount : 0,
  };
};

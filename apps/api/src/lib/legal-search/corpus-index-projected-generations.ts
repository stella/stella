import { TaggedError } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import {
  CORPUS_INDEX_ACTIVE_GENERATION_STATUSES,
  type CorpusFamily,
  type CorpusIndexGenerationStatus,
  isActiveCorpusIndexGenerationStatus,
} from "@/api/lib/legal-search/corpus-generation-contract";
import { requireRegisteredCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  CORPUS_INDEX_MANIFESTS,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

// The one reading of which generations a canonical writer owes a projection.
//
// The registry, not this process, decides which generations exist: a
// generation registered by a newer release is just as owed as one this
// release compiled. A writer that filtered the registry by the manifests it
// was built with would project a subset and say nothing, leaving the
// generation it does not know stale (or without a state at all) while every
// generation it does know reads current. So the set is read here, from every
// registry row of the family, and a writer that cannot project all of it is
// refused before it writes.

/**
 * The statuses a canonical writer owes something. A building or serving
 * generation takes every change (`CORPUS_INDEX_ACTIVE_GENERATION_STATUSES`);
 * a retiring one still holds what it was given, so it takes erasures. Only a
 * retired generation is owed nothing, so only it may be unknown to a writer.
 */
const CORPUS_INDEX_PROJECTED_GENERATION_STATUSES = [
  ...CORPUS_INDEX_ACTIVE_GENERATION_STATUSES,
  "retiring",
] as const satisfies readonly CorpusIndexGenerationStatus[];

/**
 * The registry lists a generation this process has no manifest for, in a
 * status writers must project. The process runs a release older than the one
 * that registered the generation; the writing transaction is refused whole
 * (nothing of it commits) and the same write succeeds from a process of a
 * release that knows the generation. Graded transient: retry it, never record
 * the input as rejected.
 */
export class CorpusIndexGenerationUnknownError extends TaggedError(
  "CorpusIndexGenerationUnknownError",
)<{
  message: string;
  family: CorpusFamily;
  unknown: readonly {
    generation: string;
    status: CorpusIndexGenerationStatus;
  }[];
}> {}

export type ProjectedCorpusIndexGeneration = {
  generation: string;
  manifest: CorpusIndexManifest;
  /** Whether the generation may still be given content, or only relieved of it. */
  accepts: "content" | "erase-only";
};

const compiledGenerations = (family: CorpusFamily): ReadonlySet<string> =>
  new Set(
    Object.values(CORPUS_INDEX_MANIFESTS).flatMap((manifest) =>
      manifest.family === family ? [manifest.generation] : [],
    ),
  );

/**
 * Every generation of the family a canonical writer must project, with what
 * it may be told; refuses with `CorpusIndexGenerationUnknownError` when any of
 * them has no manifest in this process. Callers join the writer fence
 * (`lockCorpusIndexProjectionWriterTx`) first when they write: registration
 * and status changes take the same fence, so the set holds until commit.
 */
export const readProjectedCorpusIndexGenerationsTx = async (
  tx: Pick<Transaction, "select">,
  family: CorpusFamily,
): Promise<ProjectedCorpusIndexGeneration[]> => {
  const compiled = compiledGenerations(family);
  // A generation is registered once per family (primary key), so more rows
  // than this release compiled means at least one of them is unknown, and the
  // read never has to grow with the registry.
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, family),
        inArray(
          corpusIndexGenerations.status,
          CORPUS_INDEX_PROJECTED_GENERATION_STATUSES,
        ),
      ),
    )
    .orderBy(asc(corpusIndexGenerations.generation))
    .limit(compiled.size + 1);
  const unknown = rows.filter(({ generation }) => !compiled.has(generation));
  if (unknown.length > 0) {
    // Rolls the caller's transaction back whole: nothing it wrote before
    // this read commits without the generation it would have skipped.
    abortTransaction(
      new CorpusIndexGenerationUnknownError({
        message: `Corpus generation registry lists ${unknown
          .map(
            ({ generation, status }) => `${family}/${generation} (${status})`,
          )
          .join(
            ", ",
          )}, which this release has no manifest for; its writers would skip it`,
        family,
        unknown: unknown.map(({ generation, status }) => ({
          generation,
          status,
        })),
      }),
    );
  }
  return rows.map((row) => ({
    generation: row.generation,
    manifest: requireRegisteredCorpusIndexManifest(row),
    accepts: isActiveCorpusIndexGenerationStatus(row.status)
      ? "content"
      : "erase-only",
  }));
};

/**
 * Every generation the registry holds for the family, whatever its status and
 * whether or not this process compiled it: where a projection state can
 * exist. A subquery, for reads that ask whether any generation holds a row.
 */
export const registeredCorpusIndexGenerationsQuery = (
  tx: Pick<Transaction, "select">,
  family: CorpusFamily,
) =>
  tx
    .select({ generation: corpusIndexGenerations.generation })
    .from(corpusIndexGenerations)
    .where(eq(corpusIndexGenerations.family, family));

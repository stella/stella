/**
 * Retire one corpus generation for good: the one owner of the decision and
 * of what follows it.
 *
 * 1. Decide (`readCorpusIndexRetireTx`): the generation must be registered
 *    with the manifest the code declares and building. A serving generation
 *    is refused (readers use it), a retiring one is a rebuild in progress, a
 *    generation a flip named within the keep window is the flip's way back,
 *    one a jurisdiction pointer names still serves or is being erased for a
 *    jurisdiction, and one with a leased revision has a runner writing to it.
 *    An already retired generation needs no decision: its cleanup resumes.
 * 2. Retire (`retireCorpusIndexGenerationTx`): under the activation and the
 *    exclusive projection fences, the decision is taken again and the
 *    generation moves to retired with its receipt and a system audit run,
 *    in one transaction. From that commit on no writer projects it (writers
 *    read the registry by status) and the database refuses any state or
 *    revision written to it.
 * 3. Delete its engine indexes (`deleteRetiredCorpusIndexGenerationIndexes`):
 *    every physical index the engine lists whose id carries this
 *    generation's name, and no other; then the list is read again.
 * 4. Delete its projection history page by page
 *    (`purgeRetiredCorpusIndexGenerationPageTx` in the registry store), which
 *    the operator command walks under the database-load brake. A crashed walk
 *    resumes by running the command again.
 */

import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { declareFingerprintFields } from "@stll/errors";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexJurisdictionServing,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { setSharedTransactionTimeouts } from "@/api/db/shared-pool-timeouts";
import { createSafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import type {
  CorpusFamily,
  CorpusIndexGenerationStatus,
} from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexFlipBusyReasonOf } from "@/api/lib/legal-search/corpus-index-generation-flip";
import {
  lockCorpusIndexGenerationActivationTx,
  markCorpusIndexGenerationRetiredTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { lockCorpusIndexProjectionFlipTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

/**
 * How long after a flip the generations it named stay its way back (the
 * decided keep window: the demoted generation keeps taking every change for
 * a week, so the same guard can flip back to it).
 */
const CORPUS_INDEX_RETIRE_KEEP_WINDOW_DAYS = 7;

/** How long the retire waits for any one lock before it refuses. */
const RETIRE_LOCK_TIMEOUT_MS = 2000;
/** How long any one statement under the fences may run before it refuses. */
const RETIRE_STATEMENT_TIMEOUT_MS = 20_000;
/** Pointers or leases one refusal lists. */
const REFUSAL_SAMPLE = 5;

type CorpusIndexRetireTarget = {
  family: CorpusFamily;
  generation: string;
};

type BusyReason = NonNullable<ReturnType<typeof corpusIndexFlipBusyReasonOf>>;

/** Why a generation was not retired, by class, so a caller can tell a refusal to fix from one to retry. */
export type CorpusIndexRetireRefusal =
  | {
      class: "registry";
      reason: "not_registered" | "contract_mismatch" | "serving" | "rebuilding";
    }
  | { class: "flip"; reason: "keep_window" }
  | { class: "pointer"; reason: "jurisdiction_serving" }
  | { class: "in_flight"; reason: "leased_revisions" }
  | { class: "busy"; reason: BusyReason };

export class CorpusIndexGenerationRetireRefusedError extends TaggedError(
  "CorpusIndexGenerationRetireRefusedError",
)<{
  message: string;
  refusal: CorpusIndexRetireRefusal;
  /** The refusal's reason, the field failures are grouped by. */
  reason: CorpusIndexRetireRefusal["reason"];
  /** One line per finding an operator acts on. */
  details: readonly string[];
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const refuse = (
  refusal: CorpusIndexRetireRefusal,
  message: string,
  details: readonly string[] = [],
) =>
  Result.err(
    new CorpusIndexGenerationRetireRefusedError({
      message,
      refusal,
      reason: refusal.reason,
      details,
    }),
  );

type CorpusIndexRetireReceipt = {
  retiredAt: Date;
  retireActor: string;
  retireReason: string;
};

/** What the registry says the retire has to do. */
export type CorpusIndexRetireDecision =
  | { type: "retire"; target: CorpusIndexRetireTarget }
  | {
      type: "already_retired";
      target: CorpusIndexRetireTarget;
      /** Null for a generation retired before the retire command existed. */
      receipt: CorpusIndexRetireReceipt | null;
    };

type ReadTransaction = Pick<Transaction, "select">;

const statusRefusal = (
  target: CorpusIndexRetireTarget,
  status: Exclude<CorpusIndexGenerationStatus, "building" | "retired">,
) => {
  switch (status) {
    case "serving":
      return refuse(
        { class: "registry", reason: "serving" },
        `${target.family}/${target.generation} serves its family; flip the family to another generation first`,
      );
    case "retiring":
      return refuse(
        { class: "registry", reason: "rebuilding" },
        `${target.family}/${target.generation} is retiring, which a rebuild in progress holds; let the rebuild finish first`,
      );
    default:
      status satisfies never;
      return panic(`Unhandled generation status: ${String(status)}`);
  }
};

/** Flips within the keep window that name the generation, newest first. */
const recentFlipsTx = async (
  tx: ReadTransaction,
  target: CorpusIndexRetireTarget,
) =>
  await readBounded(
    tx
      .select({
        from: corpusIndexGenerationFlips.fromGeneration,
        to: corpusIndexGenerationFlips.toGeneration,
        flippedAt: corpusIndexGenerationFlips.flippedAt,
      })
      .from(corpusIndexGenerationFlips)
      .where(
        and(
          eq(corpusIndexGenerationFlips.family, target.family),
          or(
            eq(corpusIndexGenerationFlips.fromGeneration, target.generation),
            eq(corpusIndexGenerationFlips.toGeneration, target.generation),
          ),
          // Against the database clock, at the column's own precision.
          sql`${corpusIndexGenerationFlips.flippedAt} > clock_timestamp() - ${sql.raw(
            `interval '${String(CORPUS_INDEX_RETIRE_KEEP_WINDOW_DAYS)} days'`,
          )}`,
        ),
      )
      .orderBy(sql`${corpusIndexGenerationFlips.flippedAt} DESC`),
    REFUSAL_SAMPLE,
  );

/** Jurisdiction pointers that serve the generation or erase from it. */
const pointersTx = async (
  tx: ReadTransaction,
  target: CorpusIndexRetireTarget,
) =>
  await readBounded(
    tx
      .select({
        jurisdiction: corpusIndexJurisdictionServing.jurisdiction,
        generation: corpusIndexJurisdictionServing.generation,
        fromGeneration: corpusIndexJurisdictionServing.fromGeneration,
      })
      .from(corpusIndexJurisdictionServing)
      .where(
        and(
          eq(corpusIndexJurisdictionServing.family, target.family),
          or(
            eq(corpusIndexJurisdictionServing.generation, target.generation),
            eq(
              corpusIndexJurisdictionServing.fromGeneration,
              target.generation,
            ),
          ),
        ),
      ),
    REFUSAL_SAMPLE,
  );

/**
 * Revisions a runner holds a live lease on: a projection worker or an
 * offline build is writing to the generation now.
 */
const leasedRevisionsTx = async (
  tx: ReadTransaction,
  target: CorpusIndexRetireTarget,
) =>
  await readBounded(
    tx
      .select({
        indexId: corpusIndexProjectionIntents.indexId,
        status: corpusIndexProjectionIntents.status,
        leaseExpiresAt: corpusIndexProjectionIntents.leaseExpiresAt,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          eq(corpusIndexProjectionIntents.family, target.family),
          eq(corpusIndexProjectionIntents.generation, target.generation),
          // The statuses that take a lease (the expired-lease index's predicate).
          inArray(corpusIndexProjectionIntents.status, [
            "reserved",
            "append_started",
            "cleanup_started",
          ]),
          sql`${corpusIndexProjectionIntents.leaseExpiresAt} > clock_timestamp()`,
        ),
      ),
    REFUSAL_SAMPLE,
  );

/**
 * Decide the retire from what PostgreSQL holds now. Reads only; the retire
 * transaction calls it again under its fences.
 */
export const readCorpusIndexRetireTx = async (
  tx: ReadTransaction,
  target: CorpusIndexRetireTarget,
): Promise<
  Result<CorpusIndexRetireDecision, CorpusIndexGenerationRetireRefusedError>
> => {
  const row = (
    await tx
      .select({
        status: corpusIndexGenerations.status,
        manifestDigest: corpusIndexGenerations.manifestDigest,
        retiredAt: corpusIndexGenerations.retiredAt,
        retireActor: corpusIndexGenerations.retireActor,
        retireReason: corpusIndexGenerations.retireReason,
      })
      .from(corpusIndexGenerations)
      .where(
        and(
          eq(corpusIndexGenerations.family, target.family),
          eq(corpusIndexGenerations.generation, target.generation),
        ),
      )
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return refuse(
      { class: "registry", reason: "not_registered" },
      `${target.family}/${target.generation} is not registered; there is nothing to retire`,
    );
  }
  const declaredDigest = corpusIndexManifestDigest(
    requireCorpusIndexManifest(target.family, target.generation),
  );
  if (row.manifestDigest !== declaredDigest) {
    return refuse(
      { class: "registry", reason: "contract_mismatch" },
      `${target.family}/${target.generation} is registered with manifest digest ${row.manifestDigest}, but the code declares ${declaredDigest}`,
    );
  }
  switch (row.status) {
    case "retired":
      return Result.ok({
        type: "already_retired",
        target,
        receipt:
          row.retiredAt === null ||
          row.retireActor === null ||
          row.retireReason === null
            ? null
            : {
                retiredAt: row.retiredAt,
                retireActor: row.retireActor,
                retireReason: row.retireReason,
              },
      });
    case "serving":
    case "retiring":
      return statusRefusal(target, row.status);
    case "building":
      break;
    default:
      row.status satisfies never;
      return panic(`Unhandled generation status: ${String(row.status)}`);
  }
  const flips = await recentFlipsTx(tx, target);
  if (flips.type === "overflow" || flips.rows.length > 0) {
    return refuse(
      { class: "flip", reason: "keep_window" },
      `A flip within the last ${String(CORPUS_INDEX_RETIRE_KEEP_WINDOW_DAYS)} days names ${target.family}/${target.generation}; it stays the way back until the keep window ends`,
      flips.type === "overflow"
        ? [`more than ${String(flips.cap)} flips`]
        : flips.rows.map(
            ({ from, to, flippedAt }) =>
              `flip ${from ?? "none"} -> ${to} at ${flippedAt.toISOString()}`,
          ),
    );
  }
  const pointers = await pointersTx(tx, target);
  if (pointers.type === "overflow" || pointers.rows.length > 0) {
    return refuse(
      { class: "pointer", reason: "jurisdiction_serving" },
      `A jurisdiction serving pointer names ${target.family}/${target.generation}`,
      pointers.type === "overflow"
        ? [`more than ${String(pointers.cap)} pointers`]
        : pointers.rows.map(
            ({ jurisdiction, generation, fromGeneration }) =>
              `${jurisdiction}: served by ${generation}, flipped from ${fromGeneration}`,
          ),
    );
  }
  const leased = await leasedRevisionsTx(tx, target);
  if (leased.type === "overflow" || leased.rows.length > 0) {
    return refuse(
      { class: "in_flight", reason: "leased_revisions" },
      `A runner holds leased revisions of ${target.family}/${target.generation}; stop the runner that writes to it and retry once the leases expire`,
      leased.type === "overflow"
        ? [`more than ${String(leased.cap)} leased revisions`]
        : leased.rows.map(
            ({ indexId, status, leaseExpiresAt }) =>
              `${indexId}: ${status}, lease until ${leaseExpiresAt?.toISOString() ?? "unknown"}`,
          ),
    );
  }
  return Result.ok({ type: "retire", target });
};

/** How much projection history the generation still holds. */
export const countCorpusIndexGenerationHistoryTx = async (
  tx: ReadTransaction,
  target: CorpusIndexRetireTarget,
): Promise<{ states: number; intents: number }> => {
  const [states] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, target.family),
        eq(corpusIndexProjectionStates.generation, target.generation),
      ),
    );
  const [intents] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, target.family),
        eq(corpusIndexProjectionIntents.generation, target.generation),
      ),
    );
  return { states: states?.count ?? 0, intents: intents?.count ?? 0 };
};

type CorpusIndexRetireOutcome =
  | { type: "retired"; target: CorpusIndexRetireTarget; retiredAt: Date }
  | {
      type: "already_retired";
      target: CorpusIndexRetireTarget;
      receipt: CorpusIndexRetireReceipt | null;
    };

const retireUnderFencesTx = async (
  tx: Transaction,
  target: CorpusIndexRetireTarget,
  receipt: { actor: string; reason: string },
): Promise<
  Result<CorpusIndexRetireOutcome, CorpusIndexGenerationRetireRefusedError>
> => {
  await setSharedTransactionTimeouts(tx, {
    statementTimeoutMs: RETIRE_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: RETIRE_LOCK_TIMEOUT_MS,
  });
  // In the order canonical writers take their side of each, as the flip
  // does: source lock, then the projection fence. Under both no projection
  // state, intent, flip receipt or registry row changes until this commits,
  // so the decision read below holds for the update.
  await lockCorpusIndexGenerationActivationTx(tx, target.family);
  await lockCorpusIndexProjectionFlipTx(tx);
  const decided = await readCorpusIndexRetireTx(tx, target);
  if (decided.isErr()) {
    return Result.err(decided.error);
  }
  const decision = decided.value;
  if (decision.type === "already_retired") {
    return Result.ok(decision);
  }
  const { retiredAt } = await markCorpusIndexGenerationRetiredTx(
    tx,
    target,
    receipt,
  );
  return Result.ok({ type: "retired", target, retiredAt });
};

/**
 * Take the decision again under the activation and exclusive projection
 * fences and retire, in one transaction: refusing rather than waiting, so
 * writers are held back at most one lock timeout. The database or the lane
 * declining a lock or the time becomes a `busy` refusal; a refusal rolls its
 * transaction back. Retiring an already retired generation changes nothing.
 */
export const retireCorpusIndexGeneration = async (
  runInTransaction: IngestionTransactionRunner<Transaction>,
  target: CorpusIndexRetireTarget,
  receipt: { actor: string; reason: string },
): Promise<
  Result<CorpusIndexRetireOutcome, CorpusIndexGenerationRetireRefusedError>
> => {
  const refused: { error?: CorpusIndexGenerationRetireRefusedError } = {};
  const ran = await Result.tryPromise({
    try: async () =>
      await runInTransaction(async (tx) => {
        const outcome = await retireUnderFencesTx(tx, target, receipt);
        if (outcome.isErr()) {
          refused.error = outcome.error;
          tx.rollback();
        }
        return outcome;
      }),
    catch: (cause) => cause,
  });
  if (refused.error !== undefined) {
    return Result.err(refused.error);
  }
  if (ran.isOk()) {
    return ran.value;
  }
  const busy = corpusIndexFlipBusyReasonOf(ran.error);
  return busy === null
    ? panic(
        "Corpus generation retire transaction failed; if it failed while committing, retire again reports already_retired when it landed",
        ran.error,
      )
    : refuse(
        { class: "busy", reason: busy },
        `The retire of ${target.family}/${target.generation} did not get its locks or its time; nothing changed, retry when the projection is quieter`,
      );
};

/** The engine side of the retire: list indexes and delete them. */
export type CorpusIndexRetireEngine = Pick<
  CorpusIndexClient,
  "readPublishedSplitCounts" | "deleteIndex"
>;

class CorpusIndexRetireEngineError extends TaggedError(
  "CorpusIndexRetireEngineError",
)<{
  message: string;
  /** Indexes deleted before the failure. */
  deleted: readonly string[];
  cause?: unknown;
}> {}

type CorpusIndexRetireIndexDeletion = {
  /** Indexes of the generation the engine listed, with their published splits. */
  listed: readonly { indexId: string; publishedSplits: number }[];
  deleted: readonly string[];
};

/**
 * A registered generation's name, as the registry's CHECK states it
 * (`corpus_index_generations_name_matches_family`): the family, `_v`, and a
 * number. No such name continues with `_`, so no generation's name is a
 * prefix of another's physical index ids.
 */
const REGISTERED_GENERATION_NAME = /^(?:case_law|legislation)_v[1-9][0-9]*$/u;

/**
 * Whether the physical index belongs to the generation. Every physical id of
 * a generation is `<generation>_<route>` (`corpusIndexPattern`), and a
 * registered name never continues with `_`, so the prefix names this
 * generation's indexes and never another's, including one whose route
 * suffix this release no longer declares.
 */
export const corpusIndexBelongsToGeneration = (
  generation: string,
  indexId: string,
): boolean => {
  if (!REGISTERED_GENERATION_NAME.test(generation)) {
    return panic(`Not a registered generation name: ${generation}`);
  }
  return indexId.startsWith(`${generation}_`);
};

/**
 * Delete every engine index of a retired generation and no other: the
 * engine's own index list, filtered by `corpusIndexBelongsToGeneration`, is
 * the set, so an index no state or manifest names is found too. The list
 * is read again after the deletes, and any index still listed fails the
 * step. The caller has read the generation as retired: nothing serves it
 * and the database refuses its writers, so nothing recreates an index.
 */
export const deleteRetiredCorpusIndexGenerationIndexes = async ({
  engine,
  target,
}: {
  engine: CorpusIndexRetireEngine;
  target: CorpusIndexRetireTarget;
}): Promise<
  Result<CorpusIndexRetireIndexDeletion, CorpusIndexRetireEngineError>
> => {
  const includes = (indexId: string) =>
    corpusIndexBelongsToGeneration(target.generation, indexId);
  const listed = await engine.readPublishedSplitCounts({
    includes,
    observer: "unobserved",
  });
  if (listed.isErr()) {
    return Result.err(
      new CorpusIndexRetireEngineError({
        message: `The engine did not list the indexes of ${target.generation}: ${listed.error.message}`,
        deleted: [],
        cause: listed.error,
      }),
    );
  }
  const deleted: string[] = [];
  for (const { indexId } of listed.value) {
    // Sequential: a generation has a handful of routes.
    const removed = await engine.deleteIndex(indexId, "unobserved");
    if (removed.isErr()) {
      return Result.err(
        new CorpusIndexRetireEngineError({
          message: `The engine did not delete ${indexId}: ${removed.error.message}`,
          deleted,
          cause: removed.error,
        }),
      );
    }
    deleted.push(indexId);
  }
  const left = await engine.readPublishedSplitCounts({
    includes,
    observer: "unobserved",
  });
  if (left.isErr()) {
    return Result.err(
      new CorpusIndexRetireEngineError({
        message: `The engine did not list the indexes of ${target.generation} after the deletes: ${left.error.message}`,
        deleted,
        cause: left.error,
      }),
    );
  }
  if (left.value.length > 0) {
    return Result.err(
      new CorpusIndexRetireEngineError({
        message: `The engine still lists ${left.value.map(({ indexId }) => indexId).join(", ")} after the deletes`,
        deleted,
      }),
    );
  }
  return Result.ok({ listed: listed.value, deleted });
};

/**
 * Record what one cleanup run deleted (indexes, states, revisions) as a
 * system audit run; a run that deleted nothing records nothing.
 */
export const recordCorpusIndexRetireCleanupTx = async (
  tx: Transaction,
  deleted: { indexes: number; states: number; intents: number },
): Promise<void> => {
  await recordSystemAudit(tx, "system:corpus-generation-retire", {
    subject: createSafeId<"systemScriptRun">(),
    counts: {
      retired: 0,
      deletedIndexes: deleted.indexes,
      deletedStates: deleted.states,
      deletedIntents: deleted.intents,
    },
  });
};

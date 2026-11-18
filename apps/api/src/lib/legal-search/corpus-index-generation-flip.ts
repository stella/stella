/**
 * The one guarded flip of a corpus family's serving generation, and the only
 * owner of the decision to make it. A flip back is the same call with the
 * pair reversed: the generation a flip replaces stays `building`, so it keeps
 * taking every change and passes the same guard.
 *
 * Two phases, so nothing slow ever runs under the fence.
 *
 * Phase 1 (`prepareCorpusIndexGenerationFlip`), no locks, short read-only
 * transactions, to fail fast and to gather what the fence cannot afford:
 * - the pair as the registry holds it (status and update time of each row);
 * - every route proof of the candidate current (`readCorpusIndexRouteProofsTx`);
 * - the parity coverage walk over the serving generation's states, the long
 *   part (`walkCorpusIndexFlipCoverage`);
 * - then, last, so the window before the fence is seconds and not the walk's
 *   length: the route proofs again, and the engine read against them. Every
 *   proven index must still be the incarnation its proof walked, and hold at
 *   least as many documents in total as the revisions PostgreSQL records as
 *   applied there expect (one exact count per index, after the sum is read,
 *   so inflow can only make it refuse, never pass, a loss).
 *
 * Phase 2 (`commitCorpusIndexGenerationFlipTx`), one transaction with a short
 * `lock_timeout` and `statement_timeout`, so a busy database refuses instead
 * of making writers wait: the activation fence (canonical sources), then the
 * exclusive projection mutation fence, in the order canonical writers take
 * their side of each, so no writer can close a deadlock cycle with it. Under
 * the fence no projection state, intent or registry row can change, and it
 * re-reads, from PostgreSQL only:
 * - the pair, by identity (any lifecycle transition since phase 1 refuses);
 * - the parity verdict (`decideCorpusIndexFlipParityTx`: the walk's tail,
 *   what changed behind its cursor, and the regression statement; that module
 *   says why that makes the walk exact);
 * - the route proofs, which must be the very proofs phase 1 checked against
 *   the engine (same incarnation and pass), so an engine read is never taken
 *   under the fence and never trusted for a proof it did not read;
 * - every route of BOTH generations seeded.
 * Then it swaps: candidate building -> serving, the replaced one serving ->
 * building, and writes the receipt (whose digest PostgreSQL computes from the
 * stored row) and the system audit run with it. A dry run takes the same
 * transaction and the same fences, holding projection writers back for as
 * long as its reads take, and writes nothing: it takes no row lock, so it is
 * never even assigned a transaction id.
 *
 * Any refusal of the database to give the flip its locks or its time (a lock
 * or statement timeout, a deadlock, the operator lane's budget) is `busy`:
 * nothing was written, and a retry when the projection is quieter may pass.
 *
 * What it does not check: the search evaluation (run by hand and attached to
 * the go), and that every revision's documents are in the engine one by one:
 * the count is a total, which superseded copies not yet cleaned up also add
 * to, so it catches a loss larger than those leftovers and no other. The
 * route proof's census (at most `maxProofAgeHours` old) is what reads each
 * revision.
 */
import { panic, Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";

import { declareFingerprintFields } from "@stll/errors";

import { CorpusSchemaLaneUnavailableError } from "@/api/db/corpus-schema-lane";
import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { setSharedTransactionTimeouts } from "@/api/db/shared-pool-timeouts";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexFlipCoverageWalk,
  type CorpusIndexFlipPairRefusedError,
  type CorpusIndexFlipParity,
  type CorpusIndexFlipParityReadError,
  decideCorpusIndexFlipParityTx,
  walkCorpusIndexFlipCoverage,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import { corpusIndexGenerationFlipReceiptDigest } from "@/api/lib/legal-search/corpus-index-generation-flip-receipt";
import {
  lockCorpusIndexGenerationActivationTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexManifestDigest,
  corpusIndexManifestIsPartial,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  type CorpusIndexProjectionFlipFence,
  lockCorpusIndexProjectionFlipTx,
} from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  checkCorpusIndexRouteProofIncarnations,
  type CorpusIndexGenerationRouteProofs,
  readCorpusIndexRouteProofsTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { readCorpusIndexRouteSeedingsUnderFlipFenceTx } from "@/api/lib/legal-search/corpus-index-route-seeding";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import { isRecord } from "@/api/lib/type-guards";

/** How long the flip waits for any one lock before it refuses. */
const FLIP_LOCK_TIMEOUT_MS = 2000;
/** How long any one statement under the fence may run before it refuses. */
const FLIP_STATEMENT_TIMEOUT_MS = 20_000;

/** Registry rows one family holds: a handful. */
const REGISTRY_READ_LIMIT = 64;

/** What the engine side of the flip reads. */
export type CorpusIndexFlipEngine = Pick<
  CorpusIndexClient,
  "search" | "readIndexIncarnation"
>;

/**
 * Why a flip did not happen, by class, so a caller can tell a refusal to fix
 * (registry, parity, proofs, seeding, engine) from one to retry (busy) or to
 * finish reading (undecided).
 */
export type CorpusIndexFlipRefusal =
  | {
      class: "registry";
      reason:
        | "not_registered"
        | "not_building"
        | "contract_mismatch"
        | "partial_generation"
        | "replacing_mismatch"
        | "generation_changed"
        | "jurisdiction_serving_pointer";
    }
  | { class: "parity"; reason: "regressions" }
  | { class: "route_proofs"; reason: "not_current" | "proof_changed" }
  | { class: "seeding"; reason: "candidate_unseeded" | "serving_unseeded" }
  | { class: "engine"; reason: "index_replaced" | "documents_missing" }
  | {
      class: "busy";
      reason:
        | "lock_unavailable"
        | "statement_timeout"
        | "deadlock_victim"
        | "lane_budget_spent";
    }
  | {
      class: "undecided";
      reason: "parity_undecided" | "engine_unreadable" | "read_failed";
    };

export class CorpusIndexGenerationFlipRefusedError extends TaggedError(
  "CorpusIndexGenerationFlipRefusedError",
)<{
  message: string;
  refusal: CorpusIndexFlipRefusal;
  /** The refusal's reason, the field failures are grouped by. */
  reason: CorpusIndexFlipRefusal["reason"];
  /** One line per finding an operator acts on (routes, counts, statuses). */
  details: readonly string[];
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const refuse = (
  refusal: CorpusIndexFlipRefusal,
  message: string,
  details: readonly string[] = [],
) =>
  Result.err(
    new CorpusIndexGenerationFlipRefusedError({
      message,
      refusal,
      reason: refusal.reason,
      details,
    }),
  );

type BusyReason = Extract<CorpusIndexFlipRefusal, { class: "busy" }>["reason"];

/**
 * Whether `cause` is the database or the operator lane declining the flip its
 * locks or its time, and which. Every such failure aborts the transaction it
 * happened in, so nothing it was part of is written.
 */
export const corpusIndexFlipBusyReasonOf = (
  cause: unknown,
): BusyReason | null => {
  if (isPgError(cause, PG_ERROR.LOCK_NOT_AVAILABLE)) {
    return "lock_unavailable";
  }
  if (isPgError(cause, PG_ERROR.QUERY_CANCELED)) {
    return "statement_timeout";
  }
  if (isPgError(cause, PG_ERROR.DEADLOCK_DETECTED)) {
    return "deadlock_victim";
  }
  if (
    cause instanceof CorpusSchemaLaneUnavailableError ||
    (cause instanceof DOMException &&
      (cause.name === "TimeoutError" || cause.name === "AbortError"))
  ) {
    return "lane_budget_spent";
  }
  return null;
};

const BUSY_LINES: Record<BusyReason, string> = {
  lock_unavailable: `a lock was not granted within ${String(FLIP_LOCK_TIMEOUT_MS)} ms`,
  statement_timeout: `a statement ran past ${String(FLIP_STATEMENT_TIMEOUT_MS)} ms or was cancelled`,
  deadlock_victim: "it was chosen as a deadlock victim",
  lane_budget_spent: "the operator lane's time budget ran out",
};

const refuseBusy = (
  reason: BusyReason,
  { family, candidate }: { family: CorpusFamily; candidate: string },
) =>
  refuse(
    { class: "busy", reason },
    `The flip of ${family}/${candidate} did not get its locks or its time (${BUSY_LINES[reason]}); nothing changed, retry when the projection is quieter`,
  );

export type CorpusIndexFlipRequest = {
  family: CorpusFamily;
  /** The generation to serve. */
  candidate: string;
  /**
   * The generation the operator means to replace (null: none serves); a flip
   * whose registry says otherwise is refused. `unchecked` only for reports.
   */
  replacing:
    { type: "unchecked" } | { type: "named"; generation: string | null };
  /** Serving changes younger than this many minutes are expected lag. */
  exemptMinutes: number;
  coverage: { pageSize: number; pageBudget: number };
  /** The oldest route proof (from its pass's start) the flip accepts. */
  maxProofAgeHours: number;
};

/** A registry row as the flip identifies it. */
type RegistryIdentity = { generation: string; updatedAtUs: string };

/** One route's proof, as phase 1 checked it against the engine. */
type CheckedRouteProof = {
  indexId: string;
  incarnation: string;
  provenPassStartedAtUs: string;
  provenAtUs: string;
  inspected: number;
};

/** One route's applied documents: PostgreSQL's sum, then the engine's count. */
type RouteDocuments = {
  indexId: string;
  appliedRevisions: number;
  expected: number;
  engine: number;
};

export type CorpusIndexFlipPlan =
  | { type: "already_serving"; family: CorpusFamily; candidate: string }
  | {
      type: "flip";
      request: CorpusIndexFlipRequest;
      candidate: RegistryIdentity;
      serving: RegistryIdentity | null;
      proofs: readonly CheckedRouteProof[];
      documents: readonly RouteDocuments[];
      /** Null on a family's first flip: nothing serves, nothing to lose. */
      walk: CorpusIndexFlipCoverageWalk | null;
    };

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

const epochMicros = sql`(extract(epoch FROM ${corpusIndexGenerations.updatedAt}) * 1000000)::bigint::text`;

const readFamilyTx = async (tx: Transaction, family: CorpusFamily) => {
  const read = await readBounded(
    tx
      .select({
        generation: corpusIndexGenerations.generation,
        status: corpusIndexGenerations.status,
        manifestDigest: corpusIndexGenerations.manifestDigest,
        updatedAtUs: sql<string>`${epochMicros}`,
      })
      .from(corpusIndexGenerations)
      .where(eq(corpusIndexGenerations.family, family))
      .orderBy(corpusIndexGenerations.generation),
    REGISTRY_READ_LIMIT,
  );
  return read.type === "overflow"
    ? panic(`More generations registered than a family holds: ${family}`)
    : read.rows;
};

type RegistryReading =
  | { type: "already_serving" }
  | {
      type: "flip";
      candidate: RegistryIdentity;
      serving: RegistryIdentity | null;
    };

/** The pair the registry names, or why it cannot be flipped. */
const readPairTx = async (
  tx: Transaction,
  request: CorpusIndexFlipRequest,
): Promise<Result<RegistryReading, CorpusIndexGenerationFlipRefusedError>> => {
  const { family, candidate } = request;
  const rows = await readFamilyTx(tx, family);
  const candidateRow = rows.find(({ generation }) => generation === candidate);
  if (candidateRow === undefined) {
    return refuse(
      { class: "registry", reason: "not_registered" },
      `${family}/${candidate} is not registered; register it and let it build first`,
    );
  }
  const manifest = requireCorpusIndexManifest(family, candidate);
  if (candidateRow.manifestDigest !== corpusIndexManifestDigest(manifest)) {
    return refuse(
      { class: "registry", reason: "contract_mismatch" },
      `${family}/${candidate} is registered with manifest digest ${candidateRow.manifestDigest}, but the code declares ${corpusIndexManifestDigest(manifest)}`,
    );
  }
  if (corpusIndexManifestIsPartial(manifest)) {
    return refuse(
      { class: "registry", reason: "partial_generation" },
      `${family}/${candidate} is a partial generation and cannot serve the family`,
    );
  }
  if (candidateRow.status === "serving") {
    return Result.ok({ type: "already_serving" });
  }
  if (candidateRow.status !== "building") {
    return refuse(
      { class: "registry", reason: "not_building" },
      `${family}/${candidate} is ${candidateRow.status}; only a building generation takes every change and can serve`,
    );
  }
  const servingRows = rows.filter(({ status }) => status === "serving");
  if (servingRows.length > 1) {
    return panic(`Expected one serving corpus generation: ${family}`);
  }
  const servingRow = servingRows.at(0);
  const serving =
    servingRow === undefined
      ? null
      : {
          generation: servingRow.generation,
          updatedAtUs: servingRow.updatedAtUs,
        };
  if (
    request.replacing.type === "named" &&
    request.replacing.generation !== (serving?.generation ?? null)
  ) {
    return refuse(
      { class: "registry", reason: "replacing_mismatch" },
      `${family} is served by ${serving?.generation ?? "no generation"}, not ${request.replacing.generation ?? "no generation"} as the flip names`,
    );
  }
  return Result.ok({
    type: "flip",
    candidate: {
      generation: candidateRow.generation,
      updatedAtUs: candidateRow.updatedAtUs,
    },
    serving,
  });
};

const routeProofLines = (
  proofs: Exclude<CorpusIndexGenerationRouteProofs, { type: "all_current" }>,
): string[] => {
  switch (proofs.type) {
    case "generation_absent":
      return ["the generation is not registered"];
    case "open_route_set":
      return [
        "the generation routes per jurisdiction with no closed route set, so no route can be proven",
      ];
    case "not_ready":
      return proofs.routes.map(({ indexId, status }) => {
        switch (status.type) {
          case "current":
            return `${indexId}: current`;
          case "never_proven":
            return `${indexId}: never proven`;
          case "revoked":
            return `${indexId}: revoked (${status.reason})`;
          case "expired":
            return `${indexId}: expired (proving pass started ${status.provenPassStartedAtUs} us)`;
          case "unattested":
            return `${indexId}: group not attested (${status.reason})`;
          default:
            status satisfies never;
            return panic("Unhandled route proof status");
        }
      });
    default:
      proofs satisfies never;
      return panic("Unhandled route proofs");
  }
};

const readCurrentProofsTx = async (
  tx: Transaction,
  request: CorpusIndexFlipRequest,
): Promise<
  Result<
    Extract<CorpusIndexGenerationRouteProofs, { type: "all_current" }>,
    CorpusIndexGenerationFlipRefusedError
  >
> => {
  const proofs = await readCorpusIndexRouteProofsTx(
    tx,
    { family: request.family, generation: request.candidate },
    { maxAgeHours: request.maxProofAgeHours },
  );
  return proofs.type === "all_current"
    ? Result.ok(proofs)
    : refuse(
        { class: "route_proofs", reason: "not_current" },
        `Not every route of ${request.family}/${request.candidate} has a current proof (at most ${String(request.maxProofAgeHours)} h old)`,
        routeProofLines(proofs),
      );
};

const states = corpusIndexProjectionStates;
const intents = corpusIndexProjectionIntents;

/**
 * The documents PostgreSQL records as applied on one index: the expected
 * count of every revision a state names there. Walks the applied-census
 * index and probes each named revision by its primary key.
 */
const readAppliedDocumentsTx = async (
  tx: Transaction,
  { family, generation }: { family: CorpusFamily; generation: string },
  indexId: string,
): Promise<{ appliedRevisions: number; expected: number }> => {
  const row = executedRows(
    await tx.execute(sql`
      SELECT count(*)::int AS applied_revisions,
        coalesce(sum(named.expected), 0)::float8 AS expected
      FROM ${states}
      JOIN LATERAL (
        SELECT ${intents.expectedDocumentCount} AS expected
        FROM ${intents}
        WHERE ${intents.id} = ${states.appliedRevision}
        LIMIT 1
      ) named ON true
      WHERE ${states.family} = ${family}
        AND ${states.generation} = ${generation}
        AND ${states.appliedIndexId} = ${indexId}
        AND ${states.appliedAction} = 'upsert'
        AND ${states.appliedRevision} IS NOT NULL
    `),
  ).at(0);
  if (
    !isRecord(row) ||
    typeof row["applied_revisions"] !== "number" ||
    typeof row["expected"] !== "number" ||
    !Number.isSafeInteger(row["expected"])
  ) {
    return panic("Malformed applied document count");
  }
  return {
    appliedRevisions: row["applied_revisions"],
    expected: row["expected"],
  };
};

/** A parity refusal from either phase, as the flip's refusal. */
const refuseParity = (
  error: CorpusIndexFlipPairRefusedError | CorpusIndexFlipParityReadError,
  request: CorpusIndexFlipRequest,
) => {
  if (error._tag === "CorpusIndexFlipPairRefusedError") {
    return refuse(
      error.reason === "jurisdiction_serving_pointer"
        ? { class: "registry", reason: "jurisdiction_serving_pointer" }
        : { class: "registry", reason: "generation_changed" },
      error.message,
    );
  }
  const busy = corpusIndexFlipBusyReasonOf(error.cause);
  return busy === null
    ? refuse({ class: "undecided", reason: "read_failed" }, error.message)
    : refuseBusy(busy, request);
};

/**
 * The engine read against the proofs current now: every proven index still
 * the incarnation its proof walked, then, per route, PostgreSQL's sum of the
 * documents its applied revisions expect and the engine's total count, in
 * that order.
 */
const checkEngine = async (
  runInTransaction: ProjectionTransactionRunner,
  engine: CorpusIndexFlipEngine,
  request: CorpusIndexFlipRequest,
): Promise<
  Result<
    { proofs: readonly CheckedRouteProof[]; documents: RouteDocuments[] },
    CorpusIndexGenerationFlipRefusedError
  >
> => {
  const { family, candidate } = request;
  const proofs = await runInTransaction(
    async (tx) => await readCurrentProofsTx(tx, request),
  );
  if (proofs.isErr()) {
    return Result.err(proofs.error);
  }
  const held = await checkCorpusIndexRouteProofIncarnations({
    client: engine,
    proofs: proofs.value,
  });
  if (held.isErr()) {
    return refuse(
      { class: "undecided", reason: "engine_unreadable" },
      `Could not read the engine incarnations of ${family}/${candidate}: ${held.error.message}`,
    );
  }
  if (held.value.type === "replaced") {
    return refuse(
      { class: "engine", reason: "index_replaced" },
      `An index of ${family}/${candidate} is not the one its proof walked; prove the route again`,
      held.value.indexIds.map((indexId) => `${indexId}: replaced or missing`),
    );
  }
  const documents: RouteDocuments[] = [];
  for (const { indexId } of proofs.value.routes) {
    // db-await-in-loop: one PostgreSQL sum, then one engine count, per route, in that order
    const applied = await runInTransaction(
      async (tx) =>
        await readAppliedDocumentsTx(
          tx,
          { family, generation: candidate },
          indexId,
        ),
    );
    const counted = await engine.search({
      observer: "unobserved",
      indexId,
      query: "*",
      maxHits: 0,
    });
    if (counted.isErr()) {
      return refuse(
        { class: "undecided", reason: "engine_unreadable" },
        `Could not count the documents of ${indexId}: ${counted.error.message}`,
      );
    }
    documents.push({ indexId, ...applied, engine: counted.value.numHits });
  }
  const short = documents.filter(
    ({ expected, engine: counted }) => counted < expected,
  );
  if (short.length > 0) {
    return refuse(
      { class: "engine", reason: "documents_missing" },
      `An index of ${family}/${candidate} holds fewer documents in total than the revisions applied there expect, so some are certainly gone; prove the route again`,
      short.map(
        ({ indexId, expected, engine: counted }) =>
          `${indexId}: ${String(counted)} documents in total, applied revisions expect ${String(expected)}`,
      ),
    );
  }
  return Result.ok({ proofs: proofs.value.routes, documents });
};

/**
 * The coverage walk over the serving generation, refused when it found a
 * decision the candidate has no state for, did not reach its end, or listed
 * more uncovered states than the fenced phase probes again.
 */
const walkServing = async (
  runInTransaction: ProjectionTransactionRunner,
  request: CorpusIndexFlipRequest,
  serving: string,
): Promise<
  Result<CorpusIndexFlipCoverageWalk, CorpusIndexGenerationFlipRefusedError>
> => {
  const { family, candidate } = request;
  const walk = await walkCorpusIndexFlipCoverage({
    runInTransaction,
    family,
    candidate,
    coverage: { ...request.coverage, resumeFrom: null },
  });
  if (walk.isErr()) {
    return refuseParity(walk.error, request);
  }
  const { coverage, uncovered } = walk.value;
  if (coverage.missing > 0) {
    return refuse(
      { class: "parity", reason: "regressions" },
      `${String(coverage.missing)} decisions ${serving} shows have no state in ${candidate}`,
      coverage.sample.map((entityId) => `no state: ${entityId}`),
    );
  }
  if (coverage.type !== "complete") {
    return refuse(
      { class: "undecided", reason: "parity_undecided" },
      `The coverage walk over ${serving} did not reach its end within ${String(request.coverage.pageBudget)} pages; raise the page budget`,
    );
  }
  if (uncovered.type === "too_many") {
    return refuse(
      { class: "undecided", reason: "parity_undecided" },
      `${String(uncovered.count)} states of ${serving} have no state in ${candidate} (none wants an upsert now), more than the fenced phase can probe again; seed them in ${candidate} first`,
    );
  }
  return Result.ok(walk.value);
};

const prepareFlip = async ({
  runInTransaction,
  engine,
  request,
}: {
  runInTransaction: ProjectionTransactionRunner;
  engine: CorpusIndexFlipEngine;
  request: CorpusIndexFlipRequest;
}): Promise<
  Result<CorpusIndexFlipPlan, CorpusIndexGenerationFlipRefusedError>
> => {
  const { family, candidate } = request;
  const pair = await runInTransaction(
    async (tx) => await readPairTx(tx, request),
  );
  if (pair.isErr()) {
    return Result.err(pair.error);
  }
  if (pair.value.type === "already_serving") {
    return Result.ok({ type: "already_serving", family, candidate });
  }
  const { serving } = pair.value;
  // Fail fast: a route with no current proof refuses before the long walk.
  const proven = await runInTransaction(
    async (tx) => await readCurrentProofsTx(tx, request),
  );
  if (proven.isErr()) {
    return Result.err(proven.error);
  }
  const walk =
    serving === null
      ? Result.ok(null)
      : await walkServing(runInTransaction, request, serving.generation);
  if (walk.isErr()) {
    return Result.err(walk.error);
  }
  // Last before the fence: the engine read, against the proofs current now.
  const checked = await checkEngine(runInTransaction, engine, request);
  if (checked.isErr()) {
    return Result.err(checked.error);
  }
  return Result.ok({
    type: "flip",
    request,
    candidate: pair.value.candidate,
    serving,
    proofs: checked.value.proofs,
    documents: checked.value.documents,
    walk: walk.value,
  });
};

/**
 * Phase 1: everything that reads the engine or walks long, with no lock
 * held. `runInTransaction` should open read-only transactions.
 */
export const prepareCorpusIndexGenerationFlip = async (options: {
  runInTransaction: ProjectionTransactionRunner;
  engine: CorpusIndexFlipEngine;
  request: CorpusIndexFlipRequest;
}): Promise<
  Result<CorpusIndexFlipPlan, CorpusIndexGenerationFlipRefusedError>
> => {
  const prepared = await Result.tryPromise({
    try: async () => await prepareFlip(options),
    catch: (cause) => cause,
  });
  if (prepared.isOk()) {
    return prepared.value;
  }
  const busy = corpusIndexFlipBusyReasonOf(prepared.error);
  return busy === null
    ? panic("Corpus generation flip preparation failed", prepared.error)
    : refuseBusy(busy, options.request);
};

/** What the flip gathered, and what it read under the fence. */
type CorpusIndexFlipEvidence = {
  family: CorpusFamily;
  from: string | null;
  to: string;
  /** The pair's registry rows, read in phase 1 and found unchanged under the fence. */
  registry: { candidate: RegistryIdentity; serving: RegistryIdentity | null };
  /** Read under the fence, from the walk phase 1 made. */
  parity: {
    exemptMinutes: number;
    watermark: string;
    walk: { pages: number; walked: number; last: string | null };
    coverageWalked: number;
    tail: CorpusIndexFlipParity["tail"];
    behindCursor: CorpusIndexFlipParity["behindCursor"];
    walked: CorpusIndexFlipParity["regressions"]["walked"];
    exempt: number;
  } | null;
  /** Read in phase 1 against the engine; under the fence every one was unchanged. */
  routeProofs: readonly CheckedRouteProof[];
  /** Read in phase 1: PostgreSQL's sum, then the engine's total (a lower bound). */
  documents: readonly RouteDocuments[];
  /** Read under the fence. */
  seedings: {
    candidate: readonly { indexId: string; passNumber: number }[];
    serving: readonly { indexId: string; passNumber: number }[] | null;
  };
  /** The system audit run recorded with the receipt; null on a dry run. */
  auditRun: string | null;
};

export type CorpusIndexFlipOutcome =
  | { type: "already_serving"; family: CorpusFamily; candidate: string }
  | { type: "checked"; evidence: CorpusIndexFlipEvidence }
  | {
      type: "flipped";
      evidence: CorpusIndexFlipEvidence;
      /** As PostgreSQL computed it from the stored receipt row. */
      evidenceDigest: string;
      receiptId: SafeId<"corpusIndexGenerationFlip">;
    };

const sameProof = (left: CheckedRouteProof, right: CheckedRouteProof) =>
  left.indexId === right.indexId &&
  left.incarnation === right.incarnation &&
  left.provenPassStartedAtUs === right.provenPassStartedAtUs &&
  left.provenAtUs === right.provenAtUs;

const readSeededTx = async (
  tx: Transaction,
  fence: CorpusIndexProjectionFlipFence,
  {
    family,
    generation,
    reason,
  }: {
    family: CorpusFamily;
    generation: string;
    reason: "candidate_unseeded" | "serving_unseeded";
  },
): Promise<
  Result<
    { indexId: string; passNumber: number }[],
    CorpusIndexGenerationFlipRefusedError
  >
> => {
  const seedings = await readCorpusIndexRouteSeedingsUnderFlipFenceTx(
    tx,
    fence,
    { family, generation },
  );
  if (seedings === null) {
    return refuse(
      { class: "seeding", reason },
      `${family}/${generation} is not active, so its seeding is not kept`,
    );
  }
  const unseeded = seedings.routes.flatMap((route) =>
    route.state === "seeded" ? [] : [route],
  );
  if (seedings.routes.length === 0 || unseeded.length > 0) {
    return refuse(
      { class: "seeding", reason },
      `Not every route of ${family}/${generation} is seeded; run seed for it`,
      unseeded.map(
        ({ indexId, reason: why }) => `${indexId}: unseeded (${why})`,
      ),
    );
  }
  return Result.ok(
    seedings.routes.flatMap((route) =>
      route.state === "seeded"
        ? [{ indexId: route.indexId, passNumber: route.passNumber }]
        : [],
    ),
  );
};

/**
 * Swap the pair and record it: the receipt, whose digest PostgreSQL computes
 * from the row it stores, and the system audit run the evidence names.
 */
const recordFlipTx = async (
  tx: Transaction,
  {
    evidence,
    actor,
    reason,
  }: { evidence: CorpusIndexFlipEvidence; actor: string; reason: string },
): Promise<{
  evidence: CorpusIndexFlipEvidence;
  receiptId: SafeId<"corpusIndexGenerationFlip">;
  evidenceDigest: string;
}> => {
  await setServingCorpusIndexGenerationTx(tx, {
    family: evidence.family,
    generation: evidence.to,
  });
  const auditRun = createSafeId<"systemScriptRun">();
  const recorded = { ...evidence, auditRun };
  const receiptId = createSafeId<"corpusIndexGenerationFlip">();
  const flips = corpusIndexGenerationFlips;
  const inserted = executedRows(
    await tx.execute(sql`
      WITH receipt AS (
        SELECT ${evidence.family}::text AS family,
          ${evidence.from}::varchar AS from_generation,
          ${evidence.to}::varchar AS to_generation,
          ${actor}::varchar AS actor,
          ${reason}::varchar AS reason,
          ${JSON.stringify(recorded)}::text::jsonb AS evidence,
          clock_timestamp() AS flipped_at
      )
      INSERT INTO ${flips} (
        ${sql.identifier(flips.id.name)}, ${sql.identifier(flips.family.name)},
        ${sql.identifier(flips.fromGeneration.name)}, ${sql.identifier(flips.toGeneration.name)},
        ${sql.identifier(flips.actor.name)}, ${sql.identifier(flips.reason.name)},
        ${sql.identifier(flips.evidence.name)}, ${sql.identifier(flips.evidenceDigest.name)},
        ${sql.identifier(flips.flippedAt.name)}
      )
      SELECT ${receiptId}::uuid, receipt.family, receipt.from_generation,
        receipt.to_generation, receipt.actor, receipt.reason, receipt.evidence,
        ${corpusIndexGenerationFlipReceiptDigest({
          family: sql`receipt.family`,
          fromGeneration: sql`receipt.from_generation`,
          toGeneration: sql`receipt.to_generation`,
          actor: sql`receipt.actor`,
          reason: sql`receipt.reason`,
          flippedAt: sql`receipt.flipped_at`,
          evidence: sql`receipt.evidence`,
        })},
        receipt.flipped_at
      FROM receipt
      RETURNING ${sql.identifier(flips.evidenceDigest.name)} AS evidence_digest
    `),
  ).at(0);
  const evidenceDigest =
    isRecord(inserted) && typeof inserted["evidence_digest"] === "string"
      ? inserted["evidence_digest"]
      : panic("The flip receipt insert returned no digest");
  await recordSystemAudit(tx, "system:corpus-generation-operator", {
    subject: auditRun,
    counts: {
      registered: 0,
      promoted: 1,
      demoted: evidence.from === null ? 0 : 1,
    },
  });
  return { evidence: recorded, receiptId, evidenceDigest };
};

/** The registry re-read under the fence, by identity. */
const requireSamePairTx = async (
  tx: Transaction,
  plan: Extract<CorpusIndexFlipPlan, { type: "flip" }>,
): Promise<Result<void, CorpusIndexGenerationFlipRefusedError>> => {
  const { family, candidate } = plan.request;
  const rows = await readFamilyTx(tx, family);
  const candidateRow = rows.find(({ generation }) => generation === candidate);
  const servingRow = rows.find(({ status }) => status === "serving");
  const same =
    candidateRow?.status === "building" &&
    candidateRow.updatedAtUs === plan.candidate.updatedAtUs &&
    (plan.serving === null
      ? servingRow === undefined
      : servingRow?.generation === plan.serving.generation &&
        servingRow.updatedAtUs === plan.serving.updatedAtUs);
  return same
    ? Result.ok()
    : refuse(
        { class: "registry", reason: "generation_changed" },
        `The registry of ${family} changed since the flip was prepared; run it again`,
      );
};

const verdictRefusal = (decided: CorpusIndexFlipParity, candidate: string) => {
  const { verdict } = decided;
  switch (verdict.type) {
    case "no_regression":
      return null;
    case "regressions":
      return refuse(
        { class: "parity", reason: "regressions" },
        `${String(verdict.missing)} decisions have no state in ${candidate} and ${String(verdict.regressions)} are not shown or stale there`,
        [
          ...decided.coverage.sample.map((entityId) => `no state: ${entityId}`),
          ...decided.regressions.sample.map(
            ({ entityId, route, kind }) =>
              `${kind}: ${entityId} ${route ?? "(no route)"}`,
          ),
        ],
      );
    case "undecided":
      return refuse(
        { class: "undecided", reason: "parity_undecided" },
        `The parity of ${candidate} is undecided under the fence (${verdict.reason})`,
      );
    default:
      verdict satisfies never;
      return panic("Unhandled flip parity verdict");
  }
};

/**
 * Phase 2: decide and swap under the fences, refusing rather than waiting.
 * `mode: "dry_run"` takes the same transaction and fences and swaps nothing;
 * the caller's transaction then holds no write and no row lock.
 */
const commitCorpusIndexGenerationFlipTx = async (
  tx: Transaction,
  plan: Extract<CorpusIndexFlipPlan, { type: "flip" }>,
  receipt:
    { mode: "dry_run" } | { mode: "apply"; actor: string; reason: string },
): Promise<
  Result<CorpusIndexFlipOutcome, CorpusIndexGenerationFlipRefusedError>
> => {
  const { family, candidate, exemptMinutes } = plan.request;
  await setSharedTransactionTimeouts(tx, {
    statementTimeoutMs: FLIP_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: FLIP_LOCK_TIMEOUT_MS,
  });
  // In the order canonical writers take their side of each: source lock,
  // then the projection fence. Under both, no projection state, intent or
  // registry row can change until this transaction ends.
  await lockCorpusIndexGenerationActivationTx(tx, family);
  const fenced = await lockCorpusIndexProjectionFlipTx(tx);
  if (fenced.isErr()) {
    return refuseBusy(fenced.error.reason, plan.request);
  }
  const fence = fenced.value;
  const pair = await requireSamePairTx(tx, plan);
  if (pair.isErr()) {
    return Result.err(pair.error);
  }
  const parity =
    plan.walk === null
      ? Result.ok(null)
      : await decideCorpusIndexFlipParityTx(tx, plan.walk, { exemptMinutes });
  if (parity.isErr()) {
    // A read the database cut short leaves this transaction aborted, so the
    // refusal commits nothing.
    return refuseParity(parity.error, plan.request);
  }
  const decided = parity.value;
  const unsafe = decided === null ? null : verdictRefusal(decided, candidate);
  if (unsafe !== null) {
    return unsafe;
  }
  const proofs = await readCurrentProofsTx(tx, plan.request);
  if (proofs.isErr()) {
    return Result.err(proofs.error);
  }
  const changed = plan.proofs.filter(
    (checked) =>
      !proofs.value.routes.some((current) => sameProof(checked, current)),
  );
  if (changed.length > 0 || proofs.value.routes.length !== plan.proofs.length) {
    return refuse(
      { class: "route_proofs", reason: "proof_changed" },
      `A route proof of ${family}/${candidate} changed since the engine was checked; run the flip again`,
      changed.map(({ indexId }) => `${indexId}: proof changed`),
    );
  }
  const candidateSeedings = await readSeededTx(tx, fence, {
    family,
    generation: candidate,
    reason: "candidate_unseeded",
  });
  if (candidateSeedings.isErr()) {
    return Result.err(candidateSeedings.error);
  }
  const servingSeedings =
    plan.serving === null
      ? Result.ok(null)
      : await readSeededTx(tx, fence, {
          family,
          generation: plan.serving.generation,
          reason: "serving_unseeded",
        });
  if (servingSeedings.isErr()) {
    return Result.err(servingSeedings.error);
  }
  const evidence: CorpusIndexFlipEvidence = {
    family,
    from: plan.serving?.generation ?? null,
    to: candidate,
    registry: { candidate: plan.candidate, serving: plan.serving },
    parity:
      decided === null || plan.walk === null
        ? null
        : {
            exemptMinutes,
            watermark: decided.watermark.toString(),
            walk: {
              pages: plan.walk.pages.length,
              walked: plan.walk.coverage.walked,
              last: plan.walk.last,
            },
            coverageWalked: decided.coverage.walked,
            tail: decided.tail,
            behindCursor: decided.behindCursor,
            walked: decided.regressions.walked,
            exempt: decided.regressions.exempt,
          },
    routeProofs: plan.proofs,
    documents: plan.documents,
    seedings: {
      candidate: candidateSeedings.value,
      serving: servingSeedings.value,
    },
    auditRun: null,
  };
  switch (receipt.mode) {
    case "dry_run":
      return Result.ok({ type: "checked", evidence });
    case "apply": {
      const recorded = await recordFlipTx(tx, {
        evidence,
        actor: receipt.actor,
        reason: receipt.reason,
      });
      return Result.ok({ type: "flipped", ...recorded });
    }
    default:
      receipt satisfies never;
      return panic("Unhandled flip mode");
  }
};

/**
 * Run phase 2 in its own transaction and turn the database or the lane
 * declining its locks or its time into a `busy` refusal: the flip never makes
 * writers wait longer than one lock timeout, and never retries on its own.
 * A refusal rolls its transaction back, so it never commits anything, and a
 * transaction the database aborted (a read it cut short) is never asked to.
 */
export const runCorpusIndexGenerationFlip = async (
  runInTransaction: ProjectionTransactionRunner,
  plan: Extract<CorpusIndexFlipPlan, { type: "flip" }>,
  receipt: Parameters<typeof commitCorpusIndexGenerationFlipTx>[2],
): Promise<
  Result<CorpusIndexFlipOutcome, CorpusIndexGenerationFlipRefusedError>
> => {
  const refused: { error?: CorpusIndexGenerationFlipRefusedError } = {};
  const ran = await Result.tryPromise({
    try: async () =>
      await runInTransaction(async (tx) => {
        const outcome = await commitCorpusIndexGenerationFlipTx(
          tx,
          plan,
          receipt,
        );
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
        "Corpus generation flip transaction failed; if it failed while committing, `serve` again reports already_serving when the flip landed",
        ran.error,
      )
    : refuseBusy(busy, plan.request);
};

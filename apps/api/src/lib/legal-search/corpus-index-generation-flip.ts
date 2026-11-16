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
 * - the engine: every proven index still the incarnation its proof walked,
 *   and holding at least the documents of every revision PostgreSQL records
 *   as applied there (one exact count per index, after the sum is read, so
 *   inflow can only make it refuse, never pass, a loss);
 * - the parity coverage walk over the serving generation's states, the long
 *   part (`walkCorpusIndexFlipCoverage`).
 *
 * Phase 2 (`commitCorpusIndexGenerationFlipTx`), one transaction with a short
 * `lock_timeout` and `statement_timeout`, so a busy database refuses instead
 * of making writers wait: the activation fence (canonical sources), then the
 * exclusive projection mutation fence, in the order canonical writers take
 * their side of each, so no writer can close a deadlock cycle with it. Under
 * the fence no projection state, intent or registry row can change, and it
 * re-reads, from PostgreSQL only:
 * - the pair, by identity (any lifecycle transition since phase 1 refuses);
 * - the parity verdict (`decideCorpusIndexFlipParityTx`: the walk's tail and
 *   the regression statement; that module says why the walk holds here);
 * - the route proofs, which must be the very proofs phase 1 checked against
 *   the engine (same incarnation and pass), so an engine read is never taken
 *   under the fence and never trusted for a proof it did not read;
 * - every route of BOTH generations seeded (`readCorpusIndexRouteSeedingsTx`).
 * Then it swaps: candidate building -> serving, the replaced one serving ->
 * building, and writes the receipt and the system audit run with it. A dry
 * run takes the same transaction and the same fences, and swaps nothing.
 *
 * What it does not check: the search evaluation (run by hand and attached to
 * the go), and documents in an index that PostgreSQL does not know about
 * (the count check is a lower bound).
 */
import { panic, Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";

import { declareFingerprintFields } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexFlipCoverageWalk,
  type CorpusIndexFlipParity,
  decideCorpusIndexFlipParityTx,
  walkCorpusIndexFlipCoverage,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import {
  lockCorpusIndexGenerationActivationTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexManifestDigest,
  corpusIndexManifestIsPartial,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { lockCorpusIndexProjectionFlipTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  checkCorpusIndexRouteProofIncarnations,
  type CorpusIndexGenerationRouteProofs,
  readCorpusIndexRouteProofsTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { readCorpusIndexRouteSeedingsTx } from "@/api/lib/legal-search/corpus-index-route-seeding";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import { isRecord } from "@/api/lib/type-guards";

/** How long the flip waits for any one lock before it refuses. */
const FLIP_LOCK_TIMEOUT = "2s";
/** How long any one statement under the fence may run before it refuses. */
const FLIP_STATEMENT_TIMEOUT = "20s";

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
  | { class: "busy"; reason: "lock_unavailable" }
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

/**
 * Phase 1: everything that reads the engine or walks long, with no lock
 * held. `runInTransaction` should open read-only transactions.
 */
export const prepareCorpusIndexGenerationFlip = async ({
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
      `An index of ${family}/${candidate} holds fewer documents than its applied revisions; prove the route again`,
      short.map(
        ({ indexId, expected, engine: counted }) =>
          `${indexId}: ${String(counted)} documents, applied revisions expect at least ${String(expected)}`,
      ),
    );
  }
  if (serving === null) {
    return Result.ok({
      type: "flip",
      request,
      candidate: pair.value.candidate,
      serving,
      proofs: proofs.value.routes,
      documents,
      walk: null,
    });
  }
  const walk = await walkCorpusIndexFlipCoverage({
    runInTransaction,
    family,
    candidate,
    coverage: { ...request.coverage, resumeFrom: null },
  });
  if (walk.isErr()) {
    return walk.error._tag === "CorpusIndexFlipPairRefusedError"
      ? refuse(
          walk.error.reason === "jurisdiction_serving_pointer"
            ? { class: "registry", reason: "jurisdiction_serving_pointer" }
            : { class: "registry", reason: "generation_changed" },
          walk.error.message,
        )
      : refuse(
          { class: "undecided", reason: "read_failed" },
          walk.error.message,
        );
  }
  if (walk.value.coverage.missing > 0) {
    return refuse(
      { class: "parity", reason: "regressions" },
      `${String(walk.value.coverage.missing)} decisions ${serving.generation} shows have no state in ${candidate}`,
      walk.value.coverage.sample.map((entityId) => `no state: ${entityId}`),
    );
  }
  if (walk.value.coverage.type !== "complete") {
    return refuse(
      { class: "undecided", reason: "parity_undecided" },
      `The coverage walk over ${serving.generation} did not reach its end within ${String(request.coverage.pageBudget)} pages; raise the page budget`,
    );
  }
  return Result.ok({
    type: "flip",
    request,
    candidate: pair.value.candidate,
    serving,
    proofs: proofs.value.routes,
    documents,
    walk: walk.value,
  });
};

/** What the flip read under its fence, and what it did. */
type CorpusIndexFlipEvidence = {
  family: CorpusFamily;
  from: string | null;
  to: string;
  parity: {
    watermark: string;
    coverageWalked: number;
    tail: CorpusIndexFlipParity["tail"];
    walked: CorpusIndexFlipParity["regressions"]["walked"];
    exempt: number;
  } | null;
  routeProofs: readonly CheckedRouteProof[];
  documents: readonly RouteDocuments[];
  seedings: {
    candidate: readonly { indexId: string; passNumber: number }[];
    serving: readonly { indexId: string; passNumber: number }[] | null;
  };
};

export type CorpusIndexFlipOutcome =
  | { type: "already_serving"; family: CorpusFamily; candidate: string }
  | {
      type: "checked" | "flipped";
      evidence: CorpusIndexFlipEvidence;
      evidenceDigest: string;
      /** The receipt row; null on a dry run. */
      receiptId: string | null;
    };

const sameProof = (left: CheckedRouteProof, right: CheckedRouteProof) =>
  left.indexId === right.indexId &&
  left.incarnation === right.incarnation &&
  left.provenPassStartedAtUs === right.provenPassStartedAtUs &&
  left.provenAtUs === right.provenAtUs;

const readSeededTx = async (
  tx: Transaction,
  family: CorpusFamily,
  generation: string,
  reason: "candidate_unseeded" | "serving_unseeded",
): Promise<
  Result<
    { indexId: string; passNumber: number }[],
    CorpusIndexGenerationFlipRefusedError
  >
> => {
  const seedings = await readCorpusIndexRouteSeedingsTx(tx, {
    family,
    generation,
  });
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

/** SHA-256 of the evidence as stored, in hex. */
const digestOf = (evidence: CorpusIndexFlipEvidence): string =>
  sha256Hex(JSON.stringify(evidence));

/**
 * Swap the pair and record it: the receipt, and the system audit run that
 * names the same run.
 */
const recordFlipTx = async (
  tx: Transaction,
  {
    evidence,
    evidenceDigest,
    actor,
    reason,
  }: {
    evidence: CorpusIndexFlipEvidence;
    evidenceDigest: string;
    actor: string;
    reason: string;
  },
): Promise<string> => {
  await setServingCorpusIndexGenerationTx(tx, {
    family: evidence.family,
    generation: evidence.to,
  });
  const receiptId = createSafeId<"systemScriptRun">();
  await tx.insert(corpusIndexGenerationFlips).values({
    id: receiptId,
    family: evidence.family,
    fromGeneration: evidence.from,
    toGeneration: evidence.to,
    actor,
    reason,
    evidence,
    evidenceDigest,
  });
  await recordSystemAudit(tx, "system:corpus-generation-operator", {
    subject: receiptId,
    counts: {
      registered: 0,
      promoted: 1,
      demoted: evidence.from === null ? 0 : 1,
    },
  });
  return receiptId;
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

/**
 * Phase 2: decide and swap under the fences, refusing rather than waiting.
 * `mode: "dry_run"` takes the same transaction and fences and swaps nothing;
 * the caller's transaction then holds no write.
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
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${FLIP_LOCK_TIMEOUT}, true),
      set_config('statement_timeout', ${FLIP_STATEMENT_TIMEOUT}, true)`,
  );
  // In the order canonical writers take their side of each: source lock,
  // then the projection fence. Under both, no projection state, intent or
  // registry row can change until this transaction ends.
  await lockCorpusIndexGenerationActivationTx(tx, family);
  await lockCorpusIndexProjectionFlipTx(tx);
  const pair = await requireSamePairTx(tx, plan);
  if (pair.isErr()) {
    return Result.err(pair.error);
  }
  const parity =
    plan.walk === null
      ? null
      : await decideCorpusIndexFlipParityTx(tx, plan.walk, { exemptMinutes });
  if (parity !== null && parity.isErr()) {
    return parity.error._tag === "CorpusIndexFlipPairRefusedError"
      ? refuse(
          parity.error.reason === "jurisdiction_serving_pointer"
            ? { class: "registry", reason: "jurisdiction_serving_pointer" }
            : { class: "registry", reason: "generation_changed" },
          parity.error.message,
        )
      : refuse(
          { class: "undecided", reason: "read_failed" },
          parity.error.message,
        );
  }
  const decided = parity === null ? null : parity.value;
  if (decided !== null && decided.verdict.type !== "no_regression") {
    const { verdict } = decided;
    return verdict.type === "regressions"
      ? refuse(
          { class: "parity", reason: "regressions" },
          `${String(verdict.missing)} decisions have no state in ${candidate} and ${String(verdict.regressions)} are not shown or stale there`,
          decided.regressions.sample.map(
            ({ entityId, route, kind }) =>
              `${kind}: ${entityId} ${route ?? "(no route)"}`,
          ),
        )
      : refuse(
          { class: "undecided", reason: "parity_undecided" },
          `The parity of ${candidate} is undecided under the fence (${verdict.reason})`,
        );
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
  const candidateSeedings = await readSeededTx(
    tx,
    family,
    candidate,
    "candidate_unseeded",
  );
  if (candidateSeedings.isErr()) {
    return Result.err(candidateSeedings.error);
  }
  const servingSeedings =
    plan.serving === null
      ? null
      : await readSeededTx(
          tx,
          family,
          plan.serving.generation,
          "serving_unseeded",
        );
  if (servingSeedings !== null && servingSeedings.isErr()) {
    return Result.err(servingSeedings.error);
  }
  const evidence: CorpusIndexFlipEvidence = {
    family,
    from: plan.serving?.generation ?? null,
    to: candidate,
    parity:
      decided === null
        ? null
        : {
            watermark: decided.watermark.toString(),
            coverageWalked: decided.coverage.walked,
            tail: decided.tail,
            walked: decided.regressions.walked,
            exempt: decided.regressions.exempt,
          },
    routeProofs: plan.proofs,
    documents: plan.documents,
    seedings: {
      candidate: candidateSeedings.value,
      serving: servingSeedings === null ? null : servingSeedings.value,
    },
  };
  const evidenceDigest = digestOf(evidence);
  switch (receipt.mode) {
    case "dry_run":
      return Result.ok({
        type: "checked",
        evidence,
        evidenceDigest,
        receiptId: null,
      });
    case "apply":
      return Result.ok({
        type: "flipped",
        evidence,
        evidenceDigest,
        receiptId: await recordFlipTx(tx, {
          evidence,
          evidenceDigest,
          actor: receipt.actor,
          reason: receipt.reason,
        }),
      });
    default:
      receipt satisfies never;
      return panic("Unhandled flip mode");
  }
};

/**
 * Run phase 2 in its own transaction and turn a lock or statement timeout
 * into a `busy` refusal: the flip never makes writers wait longer than one
 * lock timeout, and never retries on its own.
 */
export const runCorpusIndexGenerationFlip = async (
  runInTransaction: ProjectionTransactionRunner,
  plan: Extract<CorpusIndexFlipPlan, { type: "flip" }>,
  receipt: Parameters<typeof commitCorpusIndexGenerationFlipTx>[2],
): Promise<
  Result<CorpusIndexFlipOutcome, CorpusIndexGenerationFlipRefusedError>
> => {
  const ran = await Result.tryPromise({
    try: async () =>
      await runInTransaction(
        async (tx) =>
          await commitCorpusIndexGenerationFlipTx(tx, plan, receipt),
      ),
    catch: (cause) => cause,
  });
  if (ran.isOk()) {
    return ran.value;
  }
  const cause = ran.error;
  if (
    isPgError(cause, PG_ERROR.LOCK_NOT_AVAILABLE) ||
    isPgError(cause, PG_ERROR.QUERY_CANCELED) ||
    isPgError(cause, PG_ERROR.DEADLOCK_DETECTED)
  ) {
    return refuse(
      { class: "busy", reason: "lock_unavailable" },
      `The flip of ${plan.request.family}/${plan.request.candidate} could not take its fences or finish its reads within ${FLIP_LOCK_TIMEOUT} per lock and ${FLIP_STATEMENT_TIMEOUT} per statement; nothing changed, retry when the projection is quieter`,
    );
  }
  return panic("Corpus generation flip transaction failed", cause);
};

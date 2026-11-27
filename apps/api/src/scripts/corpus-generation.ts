import { panic, Result, TaggedError } from "better-result";
/**
 * The operator command for the corpus generation registry: which generation
 * of each corpus family is registered, and which one serves.
 *
 *   bun run src/scripts/corpus-generation.ts status
 *   bun run src/scripts/corpus-generation.ts register --family case_law --generation case_law_v7 [--apply]
 *   bun run src/scripts/corpus-generation.ts serve --family case_law --generation case_law_v10 [--replacing case_law_v7 --actor <id> --reason <text> --apply]
 *   bun run src/scripts/corpus-generation.ts parity --family case_law --generation case_law_v10 [--exempt-minutes 20] [--coverage-pages 2000] [--coverage-from <entity|start>] [--list]
 *   bun run src/scripts/corpus-generation.ts seed --family case_law --generation case_law_v10 [--pages 1000]
 *   bun run src/scripts/corpus-generation.ts prove --family case_law --generation case_law_v10 [--hours 11] [--until-current] [--only-requested] [--concurrency 4]
 *   bun run src/scripts/corpus-generation.ts retire --family case_law --generation case_law_v8 [--defer-cleanup] [--actor <id> --reason <text> --apply]
 *   bun run src/scripts/corpus-generation.ts wake-deferred --family case_law --generation case_law_v11 [--dry-run | --apply]
 *
 * `serve` runs the guarded flip (`corpus-index-generation-flip.ts`), the one
 * owner of the decision: phase 1 reads the engine and walks the parity
 * coverage with no lock held, phase 2 re-checks everything PostgreSQL holds
 * under the activation and exclusive projection fences, refusing rather than
 * waiting, then swaps the pair and writes the receipt. The generation it
 * replaces stays building, so `serve` with the pair reversed flips back
 * through the same guard. A dry run (the default) takes the same transaction
 * and fences and swaps nothing; it holds projection writers back for as long
 * as its checks under the fence take (seconds), so run it as you would the
 * flip itself. `serve --apply` takes the decided watermark only: a
 * `--exempt-minutes` other than the default is for `parity` and dry runs.
 *
 * `register` covers an environment with no generation registered; it reports
 * the planned transition and writes only under `--apply`, in one transaction
 * that re-checks the registry under the activation fence and records a system
 * audit run.
 *
 * `parity` only reads: what readers would lose if the family's serving
 * generation were replaced by the named one, decision by decision
 * (`corpus-index-flip-parity.ts`).
 *
 * `seed` advances the generation's seeding pass (`corpus-index-route-seeding.ts`)
 * by bounded pages under the database-load brake, resuming from the cursor
 * the database stores, and stops when every route is seeded or the page
 * budget is spent. A page that loses a lock wait (a writer holds a row it
 * reads past the page's lock timeout) rolled back whole; the run backs off
 * and walks it again, and stops as busy only once locks stayed refused past
 * its patience. `retire`'s history cleanup does the same.
 *
 * `prove` keeps the route proofs a flip reads current
 * (`corpus-index-route-proof-runner.ts`): it walks every route of the named
 * generation, the serving one and the one the latest flip demoted (while it
 * is building), or with `--only-requested` the named generation's alone, one
 * census page at a time under the database-load brake, until its hours are
 * spent. With `--until-current` it walks only the routes whose proof is not
 * current (on the database clock, as the flip judges it), walking again any
 * proof revoked or expired meanwhile, and stops once every route is current.
 * It takes no maintenance lane: it writes route proofs and the
 * projection's own drift repairs, never canonical rows, and holding the lane
 * for hours would starve the replay ticks. It never runs inside a flip: each
 * of its transactions joins the projection mutation fence the flip holds
 * exclusively. Stop it before a flip all the same: a proof it records while
 * the flip walks makes the flip refuse (`proof_changed`).
 * `retire` retires a generation for good (`corpus-index-generation-retire.ts`):
 * a dry run (the default) reads the decision, the history the generation
 * holds and the engine indexes it owns, and changes nothing; `--apply` moves
 * it to retired in one fenced transaction with its receipt, deletes its
 * engine indexes, then deletes its projection history page by page under
 * the database-load brake. Running it again on a retired generation resumes
 * the cleanup.
 *
 * `wake-deferred` moves to the present the projection states of a generation
 * whose hits carry their revision that an earlier release queued at a retired
 * revision's settlement bound (`corpus-index-projection-deferred-wake.ts`):
 * exactly those the append walk would take but for that instant. A dry run
 * (the default) prints how many and a digest of their ids; `--apply` wakes
 * them in bounded batches that never wait on a writer's rows, then prints
 * what it passed over, which a rerun takes.
 */
import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";

import {
  BackfillLockWaitError,
  type BackfillWaitRecord,
  logBackfillWait,
  runBackfillPass,
} from "@stll/db-load-gate/backfill-pass";
import { decideStart } from "@stll/db-load-gate/health";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";
import { Temporal } from "@stll/time";

import {
  createDatabaseLoadVerdictReader,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { corpusIndexGenerations } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import { loadGateHealthConfig } from "@/api/env-online-index";
import { createSafeId } from "@/api/lib/branded-types";
import {
  type CaseLawRootHandle,
  describeMaintenanceLaneHolder,
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  CORPUS_FAMILIES,
  type CorpusFamily,
  type CorpusIndexGenerationStatus,
  parseCorpusFamily,
  parseCorpusIndexClusterForGeneration,
} from "@/api/lib/legal-search/corpus-generation-contract";
import {
  type CorpusIndexClient,
  getCorpusIndexClient,
  readCorpusIndexSearchBaseUrl,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexFlipCoverageCursor,
  type CorpusIndexFlipPairRefusedError,
  type CorpusIndexFlipParity,
  type CorpusIndexFlipParityReadError,
  readCorpusIndexFlipParity,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import {
  corpusIndexFlipBusyReasonOf,
  type CorpusIndexFlipEngine,
  type CorpusIndexFlipOutcome,
  type CorpusIndexFlipPlan,
  type CorpusIndexFlipRefusal,
  type CorpusIndexGenerationFlipRefusedError,
  prepareCorpusIndexGenerationFlip,
  runCorpusIndexGenerationFlip,
} from "@/api/lib/legal-search/corpus-index-generation-flip";
import {
  corpusIndexBelongsToGeneration,
  type CorpusIndexGenerationRetireRefusedError,
  type CorpusIndexRetireDecision,
  type CorpusIndexRetireEngine,
  type CorpusIndexRetireRefusal,
  countCorpusIndexGenerationHistoryTx,
  deleteRetiredCorpusIndexGenerationIndexes,
  readCorpusIndexRetireTx,
  recordCorpusIndexRetireCleanupTx,
  retireCorpusIndexGeneration,
} from "@/api/lib/legal-search/corpus-index-generation-retire";
import {
  lockCorpusIndexGenerationActivationTx,
  purgeRetiredCorpusIndexGenerationPageTx,
  registerCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  type CorpusIndexManifest,
  corpusIndexManifestDigest,
  corpusIndexRevisionRetrieval,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  DEFERRED_WAKE_LOCK_TIMEOUT_MS,
  type DeferredAppendStates,
  type DeferredWakeTarget,
  readDeferredAppendStatesTx,
  wakeDeferredAppendStatesBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-deferred-wake";
import { CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS } from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import {
  type CorpusIndexRouteProofRun,
  createCorpusIndexRouteProofBrake,
  runCorpusIndexRouteProofs,
} from "@/api/lib/legal-search/corpus-index-route-proof-runner";
import {
  advanceCorpusIndexGenerationSeedingTx,
  type CorpusIndexSeedingAdvance,
  readCorpusIndexRouteSeedingsTx,
} from "@/api/lib/legal-search/corpus-index-route-seeding";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

/**
 * One commit window of the slowest generation (600 s) plus the time its
 * presence proof takes: a serving apply younger than this is the candidate's
 * expected lag.
 */
const PARITY_DEFAULT_EXEMPT_MINUTES = 20;
/** The longest exemption an operator may ask for: one day. */
const PARITY_MAX_EXEMPT_MINUTES = 1440;
/** Serving copies one coverage transaction reads. */
const PARITY_COVERAGE_PAGE = 1000;
/** Coverage pages one run reads by default: two million serving copies. */
const PARITY_DEFAULT_COVERAGE_PAGES = 2000;
/** The most coverage pages one run may be asked for. */
const PARITY_MAX_COVERAGE_PAGES = 20_000;
/** Canonical ids one seeding page walks: the bootstrap page's bound. */
const SEED_PAGE_LIMIT = 1000;
/** Seeding pages one run walks by default: a million canonical rows. */
const SEED_DEFAULT_PAGES = 1000;
/** The most seeding pages one run may be asked for. */
const SEED_MAX_PAGES = 99_999;
/**
 * Hours one proof run walks by default, and at most: under the twelve hours
 * an operator one-off of the API task may run, so the run ends on its own.
 */
const PROVE_DEFAULT_HOURS = 11;
const PROVE_MAX_HOURS = 11;
/** Routes one proof run walks at once by default, and at most. */
const PROVE_DEFAULT_CONCURRENCY = 4;
const PROVE_MAX_CONCURRENCY = 16;
/** Census pages one proof run reads at most: no run reaches it in its hours. */
const PROVE_MAX_PAGES = 10_000_000;
/** How long the proof run waits on locks (a flip's fence) or the brake. */
const PROVE_PATIENCE_MS = 15 * 60_000;
/** A load reading that admits work is trusted this long. */
const PROVE_LOAD_RECHECK_MS = 10_000;
/** The proof session's statement and lock bounds. */
const PROVE_STATEMENT_TIMEOUT_MS = 60_000;
const PROVE_LOCK_TIMEOUT_MS = 10_000;
/** The session outlives the run's hours by this much, to read its report. */
const PROVE_SESSION_GRACE_MS = 10 * 60_000;

const USAGE = `Usage: bun run src/scripts/corpus-generation.ts <command> [options]

Commands:
  status                 Print every registered generation of every family.
  register               Register a declared generation as building.
  serve                  Flip the family's serving generation to a building one,
                         guarded by parity, route proofs, seeding and engine
                         counts; the one it replaces stays building, so the
                         same command flips back. A dry run takes the same
                         fences and holds projection writers back for as long
                         as its checks under them take (seconds).
  parity                 Report what readers would lose if the generation
                         replaced the one serving its family. Reads only.
  seed                   Walk the generation's seeding pass, giving every
                         canonical row a desired state, until every route
                         is seeded or the page budget is spent. Resumable.
  prove                  Keep the route proofs a flip reads current: walk
                         every route of the generation, the serving one and
                         the one the latest flip demoted (while building),
                         or only the generation's (--only-requested), page
                         by page, until the hours are spent or, with
                         --until-current, every route is current. Resumable.
                         Stop it before a flip.
  wake-deferred          Requeue at the present the projection states of a
                         generation whose hits carry their revision that an
                         earlier release queued at a retired revision's
                         settlement bound. Never waits on a writer's rows;
                         rerun to take what it passed over.
  retire                 Retire a building generation for good: no writer
                         projects it again, its engine indexes and its
                         projection history are deleted. Refused for the
                         serving generation, one a flip named within the
                         keep window, one a jurisdiction pointer names and
                         one a runner holds leases on. Resumable.

Options (register, serve, parity, seed, prove, retire, wake-deferred):
  --family <family>      ${CORPUS_FAMILIES.join(" | ")}
  --generation <name>    A generation declared in code, e.g. case_law_v7.
  --apply                Perform the change. Omitted, the run only reports.
  --dry-run              Report only, the default; contradicts --apply.

Options (serve, retire):
  --actor <id>           Who makes the change, for its receipt; required with --apply.
  --reason <text>        Why (the go it rests on), for its receipt; required with --apply.

Options (retire):
  --defer-cleanup        Retire and delete the engine indexes, but leave the
                         projection history for a later run of retire, which
                         deletes it (after other work that must not share the
                         database with it).

Options (serve):
  --replacing <g|none>   The generation the flip replaces, as the operator expects
                         it; required with --apply.
  --max-proof-age-hours <n>
                         Oldest route proof accepted, from its pass's start
                         (default and most ${String(CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS)}).

Options (serve, parity):
  --exempt-minutes <n>   Serving applies newer than this many minutes are the
                         candidate's expected lag (default ${String(PARITY_DEFAULT_EXEMPT_MINUTES)}; serve --apply
                         takes the default only).
  --coverage-pages <n>   Coverage pages of ${String(PARITY_COVERAGE_PAGE)} serving copies to read
                         (default ${String(PARITY_DEFAULT_COVERAGE_PAGES)} for parity, ${String(PARITY_MAX_COVERAGE_PAGES)} for serve, at most
                         ${String(PARITY_MAX_COVERAGE_PAGES)}); a walk that does not reach the end leaves
                         the verdict undecided.

Options (parity):
  --coverage-from <e>    Resume a walk after serving entity e (or "start");
                         a resumed walk never proves the verdict.
  --list                 Also print up to 50 decisions of each kind by id.

Options (seed):
  --pages <n>            Pages of ${String(SEED_PAGE_LIMIT)} canonical rows to walk (default
                         ${String(SEED_DEFAULT_PAGES)}, at most ${String(SEED_MAX_PAGES)}); the next run resumes.

Options (prove):
  --hours <n>            Hours to walk (default and most ${String(PROVE_MAX_HOURS)}).
  --until-current        Walk only the routes whose proof is not current
                         (again once one is revoked or expires), and stop as
                         soon as every route of every proven generation is
                         current.
  --only-requested       Prove the named generation alone: not the serving
                         one, nor the one the latest flip demoted.
  --concurrency <n>      Routes walked at once (default ${String(PROVE_DEFAULT_CONCURRENCY)}, at most ${String(PROVE_MAX_CONCURRENCY)}).

Exit codes (serve): 0 flipped (or, dry run, every check passed), 3 parity
regressions, 4 undecided, 10 registry, 11 route proofs, 12 seeding, 13 engine
evidence, 14 busy (a fence or read timed out; nothing changed), 1 refused.
Exit codes (parity): 0 no regression, 3 regressions, 4 undecided, 1 refused.
Exit codes (seed): 0 every route seeded, 5 page budget spent, 6 paused by
the database-load brake (after 15 minutes of waiting), 7 next row held by a
writer, or locks refused past 15 minutes, 8 a route appeared after the pass
began, 1 refused.
Exit codes (prove): 0 every route of every proven generation current, 5 hours
spent with a route not current, 6 paused by the database-load brake, 7 locks
refused past 15 minutes (a flip holds the projection fence), 8 a route set
aside (not attested, index missing or unknown documents), 9 a route failed
repeatedly, 1 refused.
Exit codes (wake-deferred): 0 nothing left owed (or, dry run, the count was
read), 7 states held by a writer or a batch cap left owed (rerun), 14 busy (a
lock, such as a flip's fence, refused within its timeout; rerun), 1 refused.
Exit codes (retire): 0 retired and cleaned up, or with --defer-cleanup retired
with its history left for a later run (or, dry run, nothing refuses it), 6 paused by the database-load brake (run it again to resume), 10
registry, 11 a flip within the keep window, 12 a jurisdiction pointer, 13 a
runner holds leases, 14 busy (nothing changed, or the cleanup's locks
refused past 15 minutes: run it again to resume), 15 engine, 1 refused.
`;

/** The retire receipt's reason column holds this many characters. */
const RETIRE_REASON_MAX_LENGTH = 2048;
/** Entities one retired-history page deletes at most. */
const RETIRE_PAGE_LIMIT = 1000;
/** How often the cleanup prints its progress, in pages. */
const RETIRE_PROGRESS_EVERY_PAGES = 100;

/** Rows `status` and the planners read; the registry holds a handful per family. */
const REGISTRY_READ_LIMIT = 200;
/** Budget for the write beyond its lane wait: re-check, flip, audit. */
const APPLY_TIMEOUT_MS = 60_000;
/** How long an operator write queues for the lane: past a scheduled tick, short of a long pass. */
const APPLY_LANE_WAIT_MS = 10 * 60_000;
const APPLY_QUERY_TIMEOUT_MS = 10_000;

const MODES = { dryRun: "dry_run", apply: "apply" } as const;
type Mode = (typeof MODES)[keyof typeof MODES];

const ACCESS = { read: "read", write: "write" } as const;
type Access = (typeof ACCESS)[keyof typeof ACCESS];

type GenerationTarget = { family: CorpusFamily; generation: string };

class CorpusGenerationUsageError extends TaggedError(
  "CorpusGenerationUsageError",
)<{ message: string }> {}

class CorpusGenerationUndeclaredError extends TaggedError(
  "CorpusGenerationUndeclaredError",
)<{ message: string; family: CorpusFamily; generation: string }> {}

class CorpusGenerationRetiringError extends TaggedError(
  "CorpusGenerationRetiringError",
)<{ message: string; family: CorpusFamily; generation: string }> {}

class CorpusGenerationRetiredError extends TaggedError(
  "CorpusGenerationRetiredError",
)<{ message: string; family: CorpusFamily; generation: string }> {}

class CorpusGenerationContractMismatchError extends TaggedError(
  "CorpusGenerationContractMismatchError",
)<{
  message: string;
  family: CorpusFamily;
  generation: string;
  registeredDigest: string;
  declaredDigest: string;
}> {}

class CorpusGenerationSearchEndpointMissingError extends TaggedError(
  "CorpusGenerationSearchEndpointMissingError",
)<{ message: string }> {}

export class CorpusGenerationLaneBusyError extends TaggedError(
  "CorpusGenerationLaneBusyError",
)<{ message: string }> {}

type RegistryRefusal =
  | CorpusGenerationRetiringError
  | CorpusGenerationRetiredError
  | CorpusGenerationContractMismatchError;

type ParityRefusal =
  CorpusIndexFlipPairRefusedError | CorpusIndexFlipParityReadError;

type CorpusGenerationRefusal =
  | CorpusGenerationUsageError
  | CorpusGenerationUndeclaredError
  | RegistryRefusal
  | CorpusGenerationSearchEndpointMissingError
  | ParityRefusal
  | CorpusGenerationLaneBusyError;

/** A target the code declares, with the manifest it is bound to. */
type DeclaredTarget = GenerationTarget & {
  manifest: CorpusIndexManifest;
  manifestDigest: string;
};

type CorpusGenerationCommand =
  | { type: "status" }
  | { type: "register"; target: DeclaredTarget; mode: Mode }
  | {
      type: "serve";
      target: DeclaredTarget;
      mode: Mode;
      replacing:
        { type: "unchecked" } | { type: "named"; generation: string | null };
      receipt: { actor: string; reason: string } | null;
      exemptMinutes: number;
      coveragePages: number;
      maxProofAgeHours: number;
    }
  | {
      type: "parity";
      target: DeclaredTarget;
      exemptMinutes: number;
      coveragePages: number;
      coverageFrom: CorpusIndexFlipCoverageCursor | null;
      listDecisions: boolean;
    }
  | { type: "seed"; target: DeclaredTarget; pages: number }
  | {
      type: "prove";
      target: DeclaredTarget;
      hours: number;
      untilCurrent: boolean;
      onlyRequested: boolean;
      concurrency: number;
    }
  | {
      type: "retire";
      target: DeclaredTarget;
      mode: Mode;
      receipt: { actor: string; reason: string } | null;
      /** Leave the projection history for a later run. */
      deferCleanup: boolean;
    }
  | {
      type: "wake-deferred";
      target: DeclaredTarget;
      wake: DeferredWakeTarget;
      mode: Mode;
    };

type GenerationRow = Pick<
  typeof corpusIndexGenerations.$inferSelect,
  | "family"
  | "generation"
  | "status"
  | "cluster"
  | "manifestDigest"
  | "updatedAt"
>;

const declaredTarget = (
  target: GenerationTarget,
): Result<DeclaredTarget, CorpusGenerationUndeclaredError> => {
  // The cluster declaration and the manifest set are bound at compile time
  // (`corpus-generation-contract.ts`), so a declared cluster means a manifest.
  if (
    parseCorpusIndexClusterForGeneration(target.family, target.generation) ===
    null
  ) {
    return Result.err(
      new CorpusGenerationUndeclaredError({
        message: `${target.family}/${target.generation} is not a generation the code declares; add its manifest before registering or serving it`,
        ...target,
      }),
    );
  }
  const manifest = requireCorpusIndexManifest(target.family, target.generation);
  return Result.ok({
    ...target,
    manifest,
    manifestDigest: corpusIndexManifestDigest(manifest),
  });
};

const COMMAND_NAMES = [
  "status",
  "register",
  "serve",
  "parity",
  "seed",
  "prove",
  "retire",
  "wake-deferred",
] as const;

const usageError = (message: string) =>
  Result.err(new CorpusGenerationUsageError({ message }));

/** Why `seed`'s options do not fit the command, or null when they do. */
const seedOptionRefusal = (
  name: (typeof COMMAND_NAMES)[number],
  values: {
    pages?: string | undefined;
    apply?: boolean | undefined;
    "dry-run"?: boolean | undefined;
  },
): string | null => {
  if (name !== "seed") {
    return values.pages === undefined ? null : "--pages belongs to seed.";
  }
  return values.apply === true || values["dry-run"] === true
    ? "seed writes only desired states a writer owes; it takes no --apply or --dry-run."
    : null;
};

/** The options `parseArgs` reads, as the command parsers see them. */
type CommandValues = {
  family?: string | undefined;
  generation?: string | undefined;
  apply?: boolean | undefined;
  "dry-run"?: boolean | undefined;
  "exempt-minutes"?: string | undefined;
  "coverage-pages"?: string | undefined;
  "coverage-from"?: string | undefined;
  list?: boolean | undefined;
  pages?: string | undefined;
  replacing?: string | undefined;
  actor?: string | undefined;
  reason?: string | undefined;
  "max-proof-age-hours"?: string | undefined;
  "defer-cleanup"?: boolean | undefined;
  hours?: string | undefined;
  "until-current"?: boolean | undefined;
  "only-requested"?: boolean | undefined;
  concurrency?: string | undefined;
};

/** Why `prove`'s options do not fit the command, or null when they do. */
const proveOptionRefusal = (
  name: (typeof COMMAND_NAMES)[number],
  values: CommandValues,
): string | null => {
  if (name === "prove") {
    return values.apply === true || values["dry-run"] === true
      ? "prove writes only route proofs and the repairs a census owes; it takes no --apply or --dry-run."
      : null;
  }
  return values.hours !== undefined ||
    values["until-current"] === true ||
    values["only-requested"] === true ||
    values.concurrency !== undefined
    ? "--hours, --until-current, --only-requested and --concurrency belong to prove."
    : null;
};

/** Why the options do not fit the named command, or null when they do. */
const commandOptionRefusal = (
  name: (typeof COMMAND_NAMES)[number],
  values: CommandValues,
): string | null => {
  const walkOptions =
    values["exempt-minutes"] !== undefined ||
    values["coverage-pages"] !== undefined;
  const parityOptions =
    values["coverage-from"] !== undefined || values.list === true;
  const receiptOptions =
    values.actor !== undefined || values.reason !== undefined;
  const serveOptions =
    receiptOptions ||
    values.replacing !== undefined ||
    values["max-proof-age-hours"] !== undefined;
  const proveRefusal = proveOptionRefusal(name, values);
  if (proveRefusal !== null) {
    return proveRefusal;
  }
  if (name !== "retire" && values["defer-cleanup"] === true) {
    return "--defer-cleanup belongs to retire.";
  }
  if (name === "status") {
    return values.family === undefined &&
      values.generation === undefined &&
      values.apply !== true &&
      !walkOptions &&
      !parityOptions &&
      !serveOptions
      ? null
      : "status takes no options.";
  }
  if (name !== "parity" && name !== "serve" && walkOptions) {
    return "--exempt-minutes and --coverage-pages belong to serve and parity.";
  }
  if (name !== "parity" && parityOptions) {
    return "--coverage-from and --list belong to parity.";
  }
  if (name === "retire") {
    return values.replacing === undefined &&
      values["max-proof-age-hours"] === undefined
      ? null
      : "--replacing and --max-proof-age-hours belong to serve.";
  }
  if (name !== "serve" && serveOptions) {
    return "--replacing, --actor, --reason and --max-proof-age-hours belong to serve (--actor and --reason also to retire).";
  }
  if (
    name === "parity" &&
    (values.apply === true || values["dry-run"] === true)
  ) {
    return "parity only reads; it takes no --apply or --dry-run.";
  }
  return seedOptionRefusal(name, values);
};

const parseServeCommand = (
  target: DeclaredTarget,
  mode: Mode,
  values: CommandValues,
  {
    exemptMinutes,
    coveragePages,
  }: { exemptMinutes: number; coveragePages: number },
): Result<CorpusGenerationCommand, CorpusGenerationUsageError> => {
  const maxProofAgeHours = parseWholeNumber(
    values["max-proof-age-hours"],
    CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
    CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
  );
  if (maxProofAgeHours === null || maxProofAgeHours === 0) {
    return usageError(
      `--max-proof-age-hours must be a whole number from 1 to ${String(CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS)}.`,
    );
  }
  const replacing =
    values.replacing === undefined
      ? ({ type: "unchecked" } as const)
      : ({
          type: "named",
          generation: values.replacing === "none" ? null : values.replacing,
        } as const);
  const receipt =
    values.actor === undefined || values.reason === undefined
      ? null
      : { actor: values.actor, reason: values.reason.trim() };
  if (mode === MODES.apply && exemptMinutes !== PARITY_DEFAULT_EXEMPT_MINUTES) {
    return usageError(
      `serve --apply exempts the decided ${String(PARITY_DEFAULT_EXEMPT_MINUTES)} minutes only; another --exempt-minutes is for parity and dry runs.`,
    );
  }
  if (mode === MODES.apply) {
    if (replacing.type === "unchecked" || receipt === null) {
      return usageError(
        "serve --apply needs --replacing (the generation serving now, or none), --actor and --reason.",
      );
    }
    if (!RECEIPT_ACTOR.test(receipt.actor) || receipt.reason.length === 0) {
      return usageError(
        "--actor must be a lowercase id (letters, digits, :._@/-) and --reason must not be empty.",
      );
    }
  }
  return Result.ok({
    type: "serve",
    target,
    mode,
    replacing,
    receipt,
    exemptMinutes,
    coveragePages,
    maxProofAgeHours,
  });
};

const parseRetireCommand = (
  target: DeclaredTarget,
  mode: Mode,
  values: CommandValues,
): Result<CorpusGenerationCommand, CorpusGenerationUsageError> => {
  const receipt =
    values.actor === undefined || values.reason === undefined
      ? null
      : { actor: values.actor, reason: values.reason.trim() };
  if (mode === MODES.apply) {
    if (receipt === null) {
      return usageError("retire --apply needs --actor and --reason.");
    }
    if (
      !RECEIPT_ACTOR.test(receipt.actor) ||
      receipt.reason.length === 0 ||
      receipt.reason.length > RETIRE_REASON_MAX_LENGTH
    ) {
      return usageError(
        `--actor must be a lowercase id (letters, digits, :._@/-) and --reason must hold 1 to ${String(RETIRE_REASON_MAX_LENGTH)} characters.`,
      );
    }
  }
  return Result.ok({
    type: "retire",
    target,
    mode,
    receipt,
    deferCleanup: values["defer-cleanup"] === true,
  });
};

const parseCorpusGenerationCommand = (
  args: readonly string[],
): Result<
  CorpusGenerationCommand,
  CorpusGenerationUsageError | CorpusGenerationUndeclaredError
> => {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args: [...args],
        allowPositionals: true,
        strict: true,
        options: {
          family: { type: "string" },
          generation: { type: "string" },
          apply: { type: "boolean" },
          "dry-run": { type: "boolean" },
          "exempt-minutes": { type: "string" },
          "coverage-pages": { type: "string" },
          "coverage-from": { type: "string" },
          list: { type: "boolean" },
          pages: { type: "string" },
          replacing: { type: "string" },
          actor: { type: "string" },
          reason: { type: "string" },
          "max-proof-age-hours": { type: "string" },
          "defer-cleanup": { type: "boolean" },
          hours: { type: "string" },
          "until-current": { type: "boolean" },
          "only-requested": { type: "boolean" },
          concurrency: { type: "string" },
        },
      }),
    catch: (cause) =>
      new CorpusGenerationUsageError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const { positionals, values } = parsed.value;
  const name = COMMAND_NAMES.find(
    (candidate) => positionals.length === 1 && positionals.at(0) === candidate,
  );
  if (name === undefined) {
    return usageError(
      "Name exactly one command: status, register, serve, parity, seed, prove, retire or wake-deferred.",
    );
  }
  if (values.apply === true && values["dry-run"] === true) {
    return usageError("--apply and --dry-run contradict each other; pass one.");
  }
  const optionRefusal = commandOptionRefusal(name, values);
  if (optionRefusal !== null) {
    return usageError(optionRefusal);
  }
  if (name === "status") {
    return Result.ok({ type: "status" });
  }
  const seedRefusal = seedOptionRefusal(name, values);
  if (seedRefusal !== null) {
    return usageError(seedRefusal);
  }
  const family = parseCorpusFamily(values.family);
  if (family === null) {
    return usageError(`--family must be one of ${CORPUS_FAMILIES.join(", ")}.`);
  }
  if (values.generation === undefined || values.generation.length === 0) {
    return usageError("--generation needs a value.");
  }
  const target = declaredTarget({ family, generation: values.generation });
  if (target.isErr()) {
    return Result.err(target.error);
  }
  const mode = values.apply === true ? MODES.apply : MODES.dryRun;
  const exemptMinutes = parseWholeNumber(
    values["exempt-minutes"],
    PARITY_DEFAULT_EXEMPT_MINUTES,
    PARITY_MAX_EXEMPT_MINUTES,
  );
  if (exemptMinutes === null) {
    return usageError(
      `--exempt-minutes must be a whole number from 0 to ${String(PARITY_MAX_EXEMPT_MINUTES)}.`,
    );
  }
  const coveragePages = parseWholeNumber(
    values["coverage-pages"],
    PARITY_DEFAULT_COVERAGE_PAGES,
    PARITY_MAX_COVERAGE_PAGES,
  );
  if (coveragePages === null) {
    return usageError(
      `--coverage-pages must be a whole number from 0 to ${String(PARITY_MAX_COVERAGE_PAGES)}.`,
    );
  }
  switch (name) {
    case "register":
      return Result.ok({ type: "register", target: target.value, mode });
    case "serve":
      // A flip must read every serving state, so it walks as far as allowed
      // unless told otherwise.
      return parseServeCommand(target.value, mode, values, {
        exemptMinutes,
        coveragePages:
          values["coverage-pages"] === undefined
            ? PARITY_MAX_COVERAGE_PAGES
            : coveragePages,
      });
    case "parity": {
      const coverageFrom = parseCoverageCursor(values["coverage-from"]);
      if (coverageFrom === "malformed") {
        return usageError("--coverage-from must be an entity id or start.");
      }
      return Result.ok({
        type: "parity",
        target: target.value,
        exemptMinutes,
        coveragePages,
        coverageFrom,
        listDecisions: values.list === true,
      });
    }
    case "retire":
      return parseRetireCommand(target.value, mode, values);
    case "wake-deferred": {
      const retrieval = corpusIndexRevisionRetrieval(target.value.manifest);
      if (retrieval.type !== "stored") {
        return usageError(
          `${target.value.family}/${target.value.generation} does not store its revision on its hits; its appends wait for an older revision's delete by design, so there is nothing to wake.`,
        );
      }
      return Result.ok({
        type: "wake-deferred",
        target: target.value,
        wake: {
          family: target.value.family,
          generation: target.value.generation,
          retrieval,
        },
        mode,
      });
    }
    case "seed": {
      const pages = parseWholeNumber(
        values.pages,
        SEED_DEFAULT_PAGES,
        SEED_MAX_PAGES,
      );
      return pages === null || pages === 0
        ? usageError(
            `--pages must be a whole number from 1 to ${String(SEED_MAX_PAGES)}.`,
          )
        : Result.ok({ type: "seed", target: target.value, pages });
    }
    case "prove": {
      const hours = parseWholeNumber(
        values.hours,
        PROVE_DEFAULT_HOURS,
        PROVE_MAX_HOURS,
      );
      const concurrency = parseWholeNumber(
        values.concurrency,
        PROVE_DEFAULT_CONCURRENCY,
        PROVE_MAX_CONCURRENCY,
      );
      if (hours === null || hours === 0) {
        return usageError(
          `--hours must be a whole number from 1 to ${String(PROVE_MAX_HOURS)}.`,
        );
      }
      if (concurrency === null || concurrency === 0) {
        return usageError(
          `--concurrency must be a whole number from 1 to ${String(PROVE_MAX_CONCURRENCY)}.`,
        );
      }
      return Result.ok({
        type: "prove",
        target: target.value,
        hours,
        untilCurrent: values["until-current"] === true,
        onlyRequested: values["only-requested"] === true,
        concurrency,
      });
    }
    default:
      name satisfies never;
      return panic(`Unhandled command: ${String(name)}`);
  }
};

const WHOLE_NUMBER = /^\d{1,5}$/u;

/** The receipt's actor shape, as its CHECK constraint states it. */
const RECEIPT_ACTOR = /^[a-z0-9][a-z0-9:._@/-]{0,127}$/u;

const parseWholeNumber = (
  raw: string | undefined,
  fallback: number,
  max: number,
): number | null => {
  if (raw === undefined) {
    return fallback;
  }
  if (!WHOLE_NUMBER.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return value <= max ? value : null;
};

const COVERAGE_CURSOR =
  /^(?<after>start|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

const parseCoverageCursor = (
  raw: string | undefined,
): CorpusIndexFlipCoverageCursor | null | "malformed" => {
  if (raw === undefined) {
    return null;
  }
  const match = COVERAGE_CURSOR.exec(raw);
  const after = match?.groups?.["after"];
  if (after === undefined) {
    return "malformed";
  }
  return { after: after === "start" ? null : after };
};

type RowLock = "none" | "update";

const readFamilyRowsTx = async (
  tx: Transaction,
  family: CorpusFamily,
  lock: RowLock,
): Promise<GenerationRow[]> => {
  const query = tx
    .select({
      family: corpusIndexGenerations.family,
      generation: corpusIndexGenerations.generation,
      status: corpusIndexGenerations.status,
      cluster: corpusIndexGenerations.cluster,
      manifestDigest: corpusIndexGenerations.manifestDigest,
      updatedAt: corpusIndexGenerations.updatedAt,
    })
    .from(corpusIndexGenerations)
    .where(eq(corpusIndexGenerations.family, family))
    .orderBy(corpusIndexGenerations.generation)
    .limit(REGISTRY_READ_LIMIT);
  switch (lock) {
    case "none":
      return await query;
    case "update":
      return await query.for("update");
    default:
      lock satisfies never;
      return panic(`Unhandled row lock: ${String(lock)}`);
  }
};

const requireMatchingDigest = (
  row: GenerationRow,
  target: DeclaredTarget,
): Result<void, CorpusGenerationContractMismatchError> =>
  row.manifestDigest === target.manifestDigest
    ? Result.ok()
    : Result.err(
        new CorpusGenerationContractMismatchError({
          message: `${target.family}/${target.generation} is registered with manifest digest ${row.manifestDigest}, but the code declares ${target.manifestDigest}`,
          family: target.family,
          generation: target.generation,
          registeredDigest: row.manifestDigest,
          declaredDigest: target.manifestDigest,
        }),
      );

type RegisterPlan =
  | { type: "insert"; target: DeclaredTarget }
  | {
      type: "already_registered";
      target: DeclaredTarget;
      status: Extract<CorpusIndexGenerationStatus, "building" | "serving">;
    };

/** What `register` would do to the registry as `rows` holds it. */
const planRegister = (
  rows: readonly GenerationRow[],
  target: DeclaredTarget,
): Result<RegisterPlan, RegistryRefusal> => {
  const row = rows.find(({ generation }) => generation === target.generation);
  if (row === undefined) {
    return Result.ok({ type: "insert", target });
  }
  switch (row.status) {
    case "building":
    case "serving": {
      const digest = requireMatchingDigest(row, target);
      return digest.isErr()
        ? Result.err(digest.error)
        : Result.ok({ type: "already_registered", target, status: row.status });
    }
    case "retiring":
      return Result.err(
        new CorpusGenerationRetiringError({
          message: `${target.family}/${target.generation} is retiring; it is being rebuilt or rolled back, not registered anew`,
          family: target.family,
          generation: target.generation,
        }),
      );
    case "retired":
      return Result.err(
        new CorpusGenerationRetiredError({
          message: `${target.family}/${target.generation} is retired and cannot be registered again; declare a new generation`,
          family: target.family,
          generation: target.generation,
        }),
      );
    default:
      row.status satisfies never;
      return panic(`Unhandled generation status: ${String(row.status)}`);
  }
};

/** Runs `work` on a database handle: read-only for reports, under the lane for writes. */
export type WithCorpusDatabase = <T>(
  access: Access,
  work: (rootDb: CaseLawRootHandle) => Promise<T>,
) => Promise<Result<T, CorpusGenerationLaneBusyError>>;

const withOperatorDatabase: WithCorpusDatabase = async (access, work) => {
  switch (access) {
    case "read": {
      const { rootDb } = await openCaseLawReadOnlySession();
      return Result.ok(await work(rootDb));
    }
    case "write": {
      // Bounded: the write queues behind a pass already running, outlasting
      // a scheduled tick, but refuses instead of queueing a flip for hours
      // behind a long operator pass.
      const ran = await enterCaseLawMaintenanceLane({
        mode: "bounded",
        laneWaitMs: APPLY_LANE_WAIT_MS,
        signal: AbortSignal.timeout(APPLY_LANE_WAIT_MS + APPLY_TIMEOUT_MS),
        statementTimeout: APPLY_QUERY_TIMEOUT_MS,
        lockTimeout: APPLY_QUERY_TIMEOUT_MS,
        work: async ({ rootDb }) => await work(rootDb),
      });
      return ran.status === "busy"
        ? Result.err(
            new CorpusGenerationLaneBusyError({
              message: `Another case-law maintenance pass (${describeMaintenanceLaneHolder(ran.holder)}) held the lane for ${APPLY_LANE_WAIT_MS / 60_000} minutes; retry once it finishes`,
            }),
          )
        : Result.ok(ran.value);
    }
    default:
      access satisfies never;
      return panic(`Unhandled database access: ${String(access)}`);
  }
};

/**
 * Runs a long seeding run on the root handle, holding the case-law
 * maintenance lane for the run, as the backfill scripts do.
 */
type WithSeedingDatabase = <T>(
  work: (rootDb: CaseLawRootHandle) => Promise<T>,
) => Promise<T>;

const withSeedingLane: WithSeedingDatabase = async (work) => {
  const { rootDb } = await enterCaseLawMaintenanceLane();
  return await work(rootDb);
};

/** How the seed command meets the database-load brake. */
type SeedingBrake = {
  /** The page runtime; a test replaces its load reading. */
  createRuntime: typeof createScriptBackfillRuntime;
  /** How long a run waits on the brake before it stops with `braked`. */
  maxWaitMs: number;
  /** How long pages may keep losing lock waits in a row before it stops as busy. */
  maxLockWaitMs: number;
};

const SEEDING_BRAKE: SeedingBrake = {
  createRuntime: createScriptBackfillRuntime,
  maxWaitMs: 15 * 60_000,
  maxLockWaitMs: 15 * 60_000,
};

/**
 * The page pass's wait log, plus one operator line per lost lock wait, so a
 * run that waits on a writer says so before it either goes on or stops.
 */
const pageWaitLog =
  (write: (line: string) => void) => (record: BackfillWaitRecord) => {
    logBackfillWait(record);
    if (record.reason === "lock_wait" && record.action === "wait") {
      write(
        `a page waits on a lock${lockedRelation(record.relation)} held by a writer; walking it again in ${String(Math.ceil(record.sleepMs / 1000))} s`,
      );
    }
  };

const lockedRelation = (relation: string | null) =>
  relation === null ? "" : ` on ${relation}`;

/** The line a page pass ends with when locks stayed refused past its patience. */
const lockWaitStopLine = (
  error: BackfillLockWaitError,
  maxLockWaitMs: number,
) =>
  `a lock${lockedRelation(error.relation)} stayed held by a writer past ${String(Math.round(maxLockWaitMs / 60_000))} minutes; nothing of the refused page was written; rerun to resume`;

type ProofTransaction = IngestionTransactionRunner<Transaction>;

/**
 * Runs a proof run on its own session for `budgetMs` (and a grace to read the
 * report): no maintenance lane (see the header), every transaction under the
 * shared corpus schema lane, one at a time on the session.
 */
type WithProofDatabase = <T>(
  budgetMs: number,
  work: (runInTransaction: ProofTransaction) => Promise<T>,
) => Promise<T>;

const withProofSession: WithProofDatabase = async (budgetMs, work) => {
  const [{ withLongRunningConnection }, { runUnderCorpusSchemaLane }] =
    await Promise.all([
      import("@/api/db/long-running-connection"),
      import("@/api/db/corpus-schema-lane"),
    ]);
  const signal = AbortSignal.timeout(budgetMs + PROVE_SESSION_GRACE_MS);
  return await withLongRunningConnection(
    {
      statementTimeout: PROVE_STATEMENT_TIMEOUT_MS,
      lockTimeout: PROVE_LOCK_TIMEOUT_MS,
      signal,
    },
    async ({ db }) => {
      // Routes are walked at once, but one session runs one transaction at
      // a time: each waits for the one before it.
      let pending = Promise.resolve();
      const transaction = async <Value>(
        fn: (tx: Transaction) => Promise<Value>,
      ): Promise<Value> => {
        const current = pending.then(
          async () =>
            await runUnderCorpusSchemaLane({
              database: db,
              laneWaitMs: PROVE_LOCK_TIMEOUT_MS,
              signal,
              work: fn,
            }),
        );
        pending = Result.tryPromise(async () => await current).then(
          () => undefined,
        );
        return await current;
      };
      return await work(
        async (fn) => await withAggregateTransaction({ transaction }, fn),
      );
    },
  );
};

/** How the proof run meets the database-load brake. */
type ProofBrake = {
  /** Whether the database admits background work now. */
  readDecision: (
    runInTransaction: ProofTransaction,
  ) => Promise<"start" | "wait">;
  /** How long a run waits on the brake before it stops with `braked`. */
  maxWaitMs: number;
};

const PROOF_BRAKE: ProofBrake = {
  readDecision: async (runInTransaction) => {
    const config = loadGateHealthConfig();
    const verdict = await createDatabaseLoadVerdictReader({
      db: { transaction: async (work) => await runInTransaction(work) },
      tableName: "corpus_index_projection_states",
      config,
    })();
    return decideStart(verdict, "backfill_batch", config).decision;
  },
  maxWaitMs: PROVE_PATIENCE_MS,
};

type CommandContext = {
  withDatabase: WithCorpusDatabase;
  withSeedingDatabase: WithSeedingDatabase;
  seedingBrake: SeedingBrake;
  withProofDatabase: WithProofDatabase;
  proofBrake: ProofBrake;
  proofClient: (
    manifest: CorpusIndexManifest,
  ) => Pick<CorpusIndexClient, "aggregate" | "readIndexIncarnation" | "search">;
  indexClient: (manifest: CorpusIndexManifest) => CorpusIndexFlipEngine;
  retireEngine: (manifest: CorpusIndexManifest) => CorpusIndexRetireEngine;
  searchEndpoint: (manifest: CorpusIndexManifest) => string | null;
  write: (line: string) => void;
  writeError: (line: string) => void;
};

const describeRow = ({
  family,
  generation,
  status,
  cluster,
  updatedAt,
}: GenerationRow): string =>
  [
    family.padEnd(12),
    generation.padEnd(18),
    status.padEnd(9),
    cluster.padEnd(5),
    updatedAt.toISOString(),
  ].join(" ");

const runStatus = async ({
  withDatabase,
  write,
}: CommandContext): Promise<Result<void, CorpusGenerationRefusal>> => {
  const rows = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await rootDb.transaction(
        async (tx) =>
          await tx
            .select({
              family: corpusIndexGenerations.family,
              generation: corpusIndexGenerations.generation,
              status: corpusIndexGenerations.status,
              cluster: corpusIndexGenerations.cluster,
              manifestDigest: corpusIndexGenerations.manifestDigest,
              updatedAt: corpusIndexGenerations.updatedAt,
            })
            .from(corpusIndexGenerations)
            .orderBy(
              corpusIndexGenerations.family,
              corpusIndexGenerations.generation,
            )
            .limit(REGISTRY_READ_LIMIT),
      ),
  );
  if (rows.isErr()) {
    return Result.err(rows.error);
  }
  write(
    [
      "family".padEnd(12),
      "generation".padEnd(18),
      "status".padEnd(9),
      "cluster".padEnd(5),
      "updated_at",
    ].join(" "),
  );
  for (const row of rows.value) {
    write(describeRow(row));
  }
  for (const family of CORPUS_FAMILIES) {
    if (
      !rows.value.some(
        (row) => row.family === family && row.status === "serving",
      )
    ) {
      write(`${family}: no generation serves`);
    }
  }
  return Result.ok();
};

const declaredLine = ({
  family,
  generation,
  manifest,
  manifestDigest,
}: DeclaredTarget) =>
  `checked: ${family}/${generation} is declared in code (cluster ${manifest.cluster}, manifest ${manifestDigest})`;

const modeLine = (mode: Mode, applied: string): string => {
  switch (mode) {
    case "dry_run":
      return "Dry run: nothing written. Re-run with --apply to perform it.";
    case "apply":
      return applied;
    default:
      mode satisfies never;
      return panic(`Unhandled mode: ${String(mode)}`);
  }
};

const planRegisterTx = async (tx: Transaction, target: DeclaredTarget) =>
  planRegister(await readFamilyRowsTx(tx, target.family, "none"), target);

const runRegister = async (
  context: CommandContext,
  { target, mode }: Extract<CorpusGenerationCommand, { type: "register" }>,
): Promise<Result<void, CorpusGenerationRefusal>> => {
  const { withDatabase, write } = context;
  write(`register ${target.family}/${target.generation} (${mode})`);
  write(declaredLine(target));
  const planned = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await rootDb.transaction(async (tx) => await planRegisterTx(tx, target)),
  );
  if (planned.isErr()) {
    return Result.err(planned.error);
  }
  if (planned.value.isErr()) {
    return Result.err(planned.value.error);
  }
  const plan = planned.value.value;
  switch (plan.type) {
    case "already_registered":
      write(
        `checked: already registered as ${plan.status} with the declared manifest; nothing to do`,
      );
      return Result.ok();
    case "insert":
      write(`plan: register ${target.generation} as building`);
      break;
    default:
      plan satisfies never;
      return panic(`Unhandled register plan: ${String(plan)}`);
  }
  if (mode === MODES.dryRun) {
    write(modeLine(mode, ""));
    return Result.ok();
  }
  const applied = await withDatabase(
    ACCESS.write,
    async (rootDb) =>
      await rootDb.transaction(async (tx) => {
        // The activation fence first, as canonical writers take their source
        // lock before any registry row; it also serializes every
        // registration of the family, so the re-check needs no row lock, and
        // a row lock here would precede the projection mutation fence the
        // insert takes, which projection writers take before the row.
        await lockCorpusIndexGenerationActivationTx(tx, target.family);
        const locked = await planRegisterTx(tx, target);
        if (locked.isErr() || locked.value.type === "already_registered") {
          return locked;
        }
        await registerCorpusIndexGenerationTx(tx, target.manifest);
        await recordSystemAudit(tx, "system:corpus-generation-operator", {
          subject: createSafeId<"systemScriptRun">(),
          counts: { registered: 1, promoted: 0, demoted: 0 },
        });
        return locked;
      }),
  );
  if (applied.isErr()) {
    return Result.err(applied.error);
  }
  if (applied.value.isErr()) {
    return Result.err(applied.value.error);
  }
  write(
    modeLine(
      mode,
      applied.value.value.type === "insert"
        ? `Applied: ${target.family}/${target.generation} is registered as building.`
        : `Applied: nothing to do; ${target.family}/${target.generation} was registered meanwhile.`,
    ),
  );
  return Result.ok();
};

/** Exit codes of `serve`, one per class of refusal, so a wrapper can tell them apart. */
const SERVE_EXIT = {
  flipped: 0,
  parity: 3,
  undecided: 4,
  registry: 10,
  routeProofs: 11,
  seeding: 12,
  engine: 13,
  busy: 14,
} as const satisfies Record<string, number>;

const serveExitCode = ({ class: refusalClass }: CorpusIndexFlipRefusal) => {
  switch (refusalClass) {
    case "parity":
      return SERVE_EXIT.parity;
    case "undecided":
      return SERVE_EXIT.undecided;
    case "registry":
      return SERVE_EXIT.registry;
    case "route_proofs":
      return SERVE_EXIT.routeProofs;
    case "seeding":
      return SERVE_EXIT.seeding;
    case "engine":
      return SERVE_EXIT.engine;
    case "busy":
      return SERVE_EXIT.busy;
    default:
      refusalClass satisfies never;
      return panic(`Unhandled flip refusal class: ${String(refusalClass)}`);
  }
};

/** What phase 1 found, line by line. */
const describePlan = (
  plan: Extract<CorpusIndexFlipPlan, { type: "flip" }>,
): string[] => [
  plan.serving === null
    ? `checked: no generation serves ${plan.request.family}; nothing to compare against`
    : `checked: ${plan.serving.generation} serves ${plan.request.family}; ${plan.request.candidate} is building`,
  ...plan.proofs.map(
    ({ indexId, incarnation, provenPassStartedAtUs, inspected }) =>
      `checked: ${indexId} proven by a pass started ${Temporal.Instant.fromEpochMilliseconds(Math.floor(Number(provenPassStartedAtUs) / 1000)).toString()} (${String(inspected)} revisions), engine incarnation ${incarnation} still held`,
  ),
  ...plan.documents.map(
    ({ indexId, engine, expected, appliedRevisions }) =>
      `checked: ${indexId} holds ${String(engine)} documents in total, no fewer than its ${String(appliedRevisions)} applied revisions expect (${String(expected)}); a total, not a per-revision census`,
  ),
  ...(plan.walk === null
    ? []
    : [
        `checked: coverage walk read every state of ${plan.walk.pair.serving} (${String(plan.walk.coverage.walked)} in ${String(plan.walk.pages.length)} pages); none that wants an upsert without a state in ${plan.request.candidate}`,
      ]),
];

const behindCursorLine = (
  behind: CorpusIndexFlipParity["behindCursor"],
): string => {
  switch (behind.type) {
    case "read":
      return `behind the walk's cursor: ${String(behind.pages)} pages counted again, ${String(behind.changedPages)} moved; ${String(behind.reread)} states probed again, ${String(behind.missing)} without a candidate state`;
    case "not_read":
      return "behind the walk's cursor: not read (the walk did not reach its end)";
    case "unprovable":
      return `behind the walk's cursor: cannot be proven (${behind.reason})`;
    default:
      behind satisfies never;
      return panic("Unhandled behind-cursor reading");
  }
};

/** What phase 2 decided under the fence, line by line. */
const describeOutcome = (
  outcome: Exclude<CorpusIndexFlipOutcome, { type: "already_serving" }>,
): string[] => {
  const { evidence } = outcome;
  return [
    ...(evidence.parity === null
      ? []
      : [
          `checked under the fence: no regression against ${evidence.from ?? "(none)"}; tail ${evidence.parity.tail.type === "read" ? `${String(evidence.parity.tail.walked)} states read` : evidence.parity.tail.type}; walked ${String(evidence.parity.walked.pending)} pending, ${String(evidence.parity.walked.blocked)} blocked, ${String(evidence.parity.walked.absent)} proven gone, ${String(evidence.parity.walked.atRisk)} with a delete in flight; ${String(evidence.parity.exempt)} exempt as lag younger than ${evidence.parity.watermark} (${String(evidence.parity.exemptMinutes)} minutes)`,
          `checked under the fence: ${behindCursorLine(evidence.parity.behindCursor)}`,
        ]),
    `checked under the fence: ${String(evidence.routeProofs.length)} route proofs current and unchanged since the engine was read`,
    `checked under the fence: every route of ${evidence.to} seeded (${evidence.seedings.candidate.map(({ indexId, passNumber }) => `${indexId} pass ${String(passNumber)}`).join(", ")})`,
    ...(evidence.seedings.serving === null
      ? []
      : [
          `checked under the fence: every route of ${evidence.from ?? "(none)"} seeded (${evidence.seedings.serving.map(({ indexId, passNumber }) => `${indexId} pass ${String(passNumber)}`).join(", ")})`,
        ]),
    ...(outcome.type === "flipped"
      ? [
          `receipt ${outcome.receiptId}, evidence digest ${outcome.evidenceDigest} (computed by PostgreSQL from the stored row), audit run ${outcome.evidence.auditRun ?? "-"}`,
        ]
      : []),
  ];
};

type FlipAnswer = Awaited<ReturnType<typeof runCorpusIndexGenerationFlip>>;

const runServe = async (
  context: CommandContext,
  command: Extract<CorpusGenerationCommand, { type: "serve" }>,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  const { target, mode } = command;
  const { withDatabase, write, writeError } = context;
  write(`serve ${target.family}/${target.generation} (${mode})`);
  write(declaredLine(target));
  const endpoint = context.searchEndpoint(target.manifest);
  if (endpoint === null) {
    return Result.err(
      new CorpusGenerationSearchEndpointMissingError({
        message: `No search endpoint is configured for cluster ${target.manifest.cluster}; the indexes cannot be checked`,
      }),
    );
  }
  const refused = (error: CorpusIndexGenerationFlipRefusedError) => {
    writeError(
      `refused (${error.refusal.class}: ${error.refusal.reason}): ${error.message}`,
    );
    for (const line of error.details) {
      writeError(`  ${line}`);
    }
    return Result.ok(serveExitCode(error.refusal));
  };
  const request = {
    family: target.family,
    candidate: target.generation,
    replacing: command.replacing,
    exemptMinutes: command.exemptMinutes,
    coverage: {
      pageSize: PARITY_COVERAGE_PAGE,
      pageBudget: command.coveragePages,
    },
    maxProofAgeHours: command.maxProofAgeHours,
  };
  // Phase 1: no lock held, read-only transactions.
  const prepared = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await prepareCorpusIndexGenerationFlip({
        runInTransaction: async (work) =>
          await withAggregateTransaction(rootDb, work),
        engine: context.indexClient(target.manifest),
        request,
      }),
  );
  if (prepared.isErr()) {
    return Result.err(prepared.error);
  }
  if (prepared.value.isErr()) {
    return refused(prepared.value.error);
  }
  const plan = prepared.value.value;
  if (plan.type === "already_serving") {
    write("checked: already serving with the declared manifest; nothing to do");
    return Result.ok(SERVE_EXIT.flipped);
  }
  for (const line of describePlan(plan)) {
    write(line);
  }
  write(
    plan.serving === null
      ? `plan: ${target.generation} building -> serving (first serving generation of ${target.family})`
      : `plan: ${target.generation} building -> serving; ${plan.serving.generation} serving -> building`,
  );
  // Phase 2: one transaction under the fences, on the lane even for a dry
  // run, which takes the same fences and writes nothing. The lane can run out
  // of time after the flip's transaction ended; the flip's own answer, kept
  // here, then still says whether it committed.
  const settled: { value?: FlipAnswer } = {};
  const lane = await Result.tryPromise({
    try: async () =>
      await withDatabase(ACCESS.write, async (rootDb) => {
        settled.value = await runCorpusIndexGenerationFlip(
          async (work) => await withAggregateTransaction(rootDb, work),
          plan,
          mode === MODES.apply && command.receipt !== null
            ? { mode: "apply", ...command.receipt }
            : { mode: "dry_run" },
        );
        return settled.value;
      }),
    catch: (cause) => cause,
  });
  if (lane.isOk() && lane.value.isErr()) {
    return Result.err(lane.value.error);
  }
  const answer = settled.value;
  if (answer === undefined) {
    if (lane.isOk()) {
      return panic("The flip lane returned without the flip's answer");
    }
    const busy = corpusIndexFlipBusyReasonOf(lane.error);
    if (busy === null) {
      return panic("The flip lane failed before the flip ran", lane.error);
    }
    writeError(
      `refused (busy: ${busy}): the lane or the database declined the flip its time before it ran; nothing changed, retry`,
    );
    return Result.ok(SERVE_EXIT.busy);
  }
  if (lane.isErr()) {
    writeError(
      "note: the operator lane's time budget ran out after the flip's transaction ended; its outcome below stands",
    );
  }
  if (answer.isErr()) {
    return refused(answer.error);
  }
  const outcome = answer.value;
  switch (outcome.type) {
    case "already_serving":
      write("checked: already serving; nothing to do");
      return Result.ok(SERVE_EXIT.flipped);
    case "checked":
      for (const line of describeOutcome(outcome)) {
        write(line);
      }
      write(modeLine(mode, ""));
      return Result.ok(SERVE_EXIT.flipped);
    case "flipped":
      for (const line of describeOutcome(outcome)) {
        write(line);
      }
      write(
        `Applied: ${target.family}/${target.generation} serves${outcome.evidence.from === null ? "" : `; ${outcome.evidence.from} is building and can serve again through the same guard`}. Receipt ${outcome.receiptId}.`,
      );
      return Result.ok(SERVE_EXIT.flipped);
    default:
      outcome satisfies never;
      return panic("Unhandled flip outcome");
  }
};

/** Exit codes of `parity`, so a wrapper can gate on the verdict. */
const PARITY_EXIT = {
  noRegression: 0,
  regressions: 3,
  undecided: 4,
} as const;

const describeParity = (
  parity: CorpusIndexFlipParity,
  listDecisions: boolean,
): string[] => {
  const { coverage, regressions, verdict } = parity;
  const { walked } = regressions;
  const counts =
    regressions.type === "exact"
      ? regressions.byRoute
      : regressions.lowerBoundByRoute;
  const total = counts.reduce((sum, { count }) => sum + count, 0);
  const coverageLine = (() => {
    switch (coverage.type) {
      case "complete":
        return `checked: every serving state walked (${String(coverage.walked)}); ${String(coverage.missing)} without a candidate state`;
      case "incomplete":
        return `not checked in full: ${String(coverage.walked)} serving states walked, ${String(coverage.missing)} without a candidate state; ${
          coverage.next === null
            ? "the walk resumed from a cursor, so it proves nothing"
            : `resume with --coverage-from ${coverage.next.after ?? "start"}`
        }`;
      default:
        coverage satisfies never;
        return panic("Unhandled flip coverage");
    }
  })();
  const verdictLine = (() => {
    switch (verdict.type) {
      case "no_regression":
        return "verdict: no regression";
      case "regressions":
        return `verdict: regressions remain (${String(verdict.missing)} without a candidate state, ${String(verdict.regressions)} not shown or stale)`;
      case "undecided":
        return `verdict: undecided (${verdict.reason}); known so far: ${String(verdict.knownMissing)} without a candidate state, ${String(verdict.knownRegressions)} not shown or stale`;
      default:
        verdict satisfies never;
        return panic("Unhandled flip verdict");
    }
  })();
  return [
    `checked: compared with ${parity.pair.serving}, which serves ${parity.pair.family}; pending changes younger than ${parity.watermark.toString()} are expected lag`,
    coverageLine,
    behindCursorLine(parity.behindCursor),
    `checked: unconverged states of the candidate walked: ${String(walked.pending)} pending, ${String(walked.blocked)} blocked, ${String(walked.absent)} proven gone, ${String(walked.atRisk)} with a delete in flight; ${String(regressions.exempt)} exempt as expected lag`,
    regressions.type === "exact"
      ? `not shown or stale (exact): ${String(total)}`
      : `not shown or stale (at least; a walk stopped at its cap, so this proves nothing): ${String(total)}`,
    ...counts.map(
      ({ route, kind, count }) =>
        `  ${route ?? "(no route)"} ${kind} ${String(count)}`,
    ),
    ...(listDecisions
      ? [
          ...coverage.sample.map((entityId) => `  no state: ${entityId}`),
          ...regressions.sample.map(
            ({ entityId, route, kind, servingEpoch, candidateEpoch }) =>
              `  ${kind}: ${entityId} ${route ?? "(no route)"}, serving epoch ${String(servingEpoch)}, candidate epoch ${candidateEpoch === null ? "none" : String(candidateEpoch)}`,
          ),
        ]
      : []),
    verdictLine,
  ];
};

const parityExitCode = ({ verdict }: CorpusIndexFlipParity): number => {
  switch (verdict.type) {
    case "no_regression":
      return PARITY_EXIT.noRegression;
    case "regressions":
      return PARITY_EXIT.regressions;
    case "undecided":
      return PARITY_EXIT.undecided;
    default:
      verdict satisfies never;
      return panic("Unhandled flip verdict");
  }
};

/**
 * Read-only: the coverage walk and the regression statement, in the order the
 * library owns, on one read-only session with a short transaction per page.
 * Resolves with the exit code its verdict maps to.
 */
const runParity = async (
  { withDatabase, write }: CommandContext,
  {
    target,
    exemptMinutes,
    coveragePages,
    coverageFrom,
    listDecisions,
  }: Extract<CorpusGenerationCommand, { type: "parity" }>,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  write(`parity ${target.family}/${target.generation} (read only)`);
  write(declaredLine(target));
  const read = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await readCorpusIndexFlipParity({
        runInTransaction: async (work) =>
          await withAggregateTransaction(rootDb, work),
        family: target.family,
        candidate: target.generation,
        exemptMinutes,
        coverage: {
          pageSize: PARITY_COVERAGE_PAGE,
          pageBudget: coveragePages,
          resumeFrom: coverageFrom,
        },
      }),
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  if (read.value.isErr()) {
    return Result.err(read.value.error);
  }
  for (const line of describeParity(read.value.value, listDecisions)) {
    write(line);
  }
  return Result.ok(parityExitCode(read.value.value));
};

/**
 * Exit codes of `seed`, one per reason a run stops short, so a wrapper can
 * tell a run to repeat from one to wait or to look at.
 */
const SEED_EXIT = {
  seeded: 0,
  /** The page budget ran out before the pass did; rerun to resume. */
  budgetSpent: 5,
  /** The database-load brake paused the run; rerun later. */
  braked: 6,
  /**
   * A writer holds the next row, or a lock a page needs stayed held past the
   * run's patience; rerun once it commits.
   */
  busy: 7,
  /** A route appeared after the pass began; rerun to walk a new pass. */
  routeAppeared: 8,
} as const;

const CANONICAL_TABLES = {
  case_law: "case_law_decisions",
  legislation: "legislation_documents",
} as const satisfies Record<CorpusFamily, string>;

const describeSeedingPage = (
  outcome: Exclude<CorpusIndexSeedingAdvance, { type: "inactive" }>,
  pages: number,
): string => {
  const { pass } = outcome;
  return `pass ${String(pass.number)}: ${outcome.type}; walked ${String(pass.walked)}, seeded ${String(pass.seeded)}, deferred (text not settled) ${String(pass.deferred)}, routes ${String(pass.routes.length)}, pages ${String(pages)}, last ${pass.afterEntityId ?? "-"}`;
};

/**
 * The exit code of a seed run, from how its pass ended and the route rows it
 * left: one code per reason a run stops short.
 */
export const seedRunExit = ({
  target,
  paused,
  outcome,
  seedings,
  write,
}: {
  target: Pick<DeclaredTarget, "family" | "generation">;
  /** The run stopped waiting on the database-load brake. */
  paused: boolean;
  /** The last page's outcome; null when no page ran. */
  outcome: CorpusIndexSeedingAdvance | null;
  seedings: Awaited<ReturnType<typeof readCorpusIndexRouteSeedingsTx>>;
  write: (line: string) => void;
}): Result<number, CorpusGenerationRefusal> => {
  if (paused || outcome === null) {
    write("paused by the database-load brake; rerun to resume");
    return Result.ok(SEED_EXIT.braked);
  }
  switch (outcome.type) {
    case "inactive":
      return Result.err(
        new CorpusGenerationRetiringError({
          message: `${target.family}/${target.generation} is ${outcome.status ?? "not registered"}; only a building or serving generation is seeded`,
          family: target.family,
          generation: target.generation,
        }),
      );
    case "complete":
    case "completed":
      // A completed pass covers the routes it captured as it began; a
      // route that appeared since needs another pass.
      if (
        seedings === null ||
        seedings.routes.some(({ state }) => state === "unseeded")
      ) {
        write("a route appeared after the pass began; rerun to walk it");
        return Result.ok(SEED_EXIT.routeAppeared);
      }
      write("every route of the generation is seeded");
      return Result.ok(SEED_EXIT.seeded);
    case "busy":
      write("the next row is held by a writer; rerun to resume");
      return Result.ok(SEED_EXIT.busy);
    case "advanced":
      write("page budget spent; rerun to resume from the stored cursor");
      return Result.ok(SEED_EXIT.budgetSpent);
    default:
      outcome satisfies never;
      return panic(`Unhandled seeding outcome: ${String(outcome)}`);
  }
};

/**
 * Advance the seeding pass page by page under the database-load brake
 * (`createScriptBackfillRuntime`). Each page seeds and records its cursor in
 * one transaction, so an interrupted run resumes where the database says.
 */
const runSeed = async (
  { withSeedingDatabase, seedingBrake, write }: CommandContext,
  { target, pages }: Extract<CorpusGenerationCommand, { type: "seed" }>,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  write(
    `seed ${target.family}/${target.generation} (at most ${String(pages)} pages)`,
  );
  write(declaredLine(target));
  return await withSeedingDatabase(async (rootDb) => {
    const runtime = seedingBrake.createRuntime({
      name: `corpus-seeding:${target.family}:${target.generation}`,
      tableName: CANONICAL_TABLES[target.family],
      initialSize: SEED_PAGE_LIMIT,
      db: rootDb,
    });
    let walkedPages = 0;
    // Written by the batch callback, read after the pass.
    const progress: { last: CorpusIndexSeedingAdvance | null } = {
      last: null,
    };
    const startedAt = Temporal.Now.instant().epochMilliseconds;
    const ran: { paused: boolean; lockWait: BackfillLockWaitError | null } = {
      paused: false,
      lockWait: null,
    };
    try {
      const pass = await runBackfillPass({
        step: async () =>
          await runtime.step(async ({ tx, size }) => {
            const outcome = await advanceCorpusIndexGenerationSeedingTx(
              tx,
              target,
              { limit: Math.max(1, Math.min(size, SEED_PAGE_LIMIT)) },
            );
            const advanced = outcome.type === "advanced";
            return {
              cursor:
                outcome.type === "inactive" ? null : outcome.pass.afterEntityId,
              done: !advanced || walkedPages + 1 >= pages,
              value: outcome,
            };
          }),
        onBatch: ({ value }) => {
          progress.last = value;
          if (value.type === "inactive") {
            return;
          }
          walkedPages += 1;
          const hours =
            (Temporal.Now.instant().epochMilliseconds - startedAt) / 3_600_000;
          const rate = hours > 0 ? Math.round(value.pass.walked / hours) : 0;
          write(
            `${describeSeedingPage(value, walkedPages)}; ${String(rate)} rows/h this run`,
          );
        },
        sleep: Bun.sleep,
        // A run that waits on the brake this long stops, so a wrapper sees
        // `braked` instead of a run that never returns.
        maxWaitMs: seedingBrake.maxWaitMs,
        maxLockWaitMs: seedingBrake.maxLockWaitMs,
        log: pageWaitLog(write),
      });
      if (pass.isErr()) {
        if (!(pass.error instanceof BackfillLockWaitError)) {
          throw pass.error;
        }
        ran.lockWait = pass.error;
      } else {
        ran.paused = pass.value.status === "paused";
      }
    } finally {
      await runtime.close();
    }
    if (ran.lockWait !== null) {
      write(lockWaitStopLine(ran.lockWait, seedingBrake.maxLockWaitMs));
      return Result.ok(SEED_EXIT.busy);
    }
    const outcome = progress.last;
    const seedings = await withAggregateTransaction(
      rootDb,
      async (tx) => await readCorpusIndexRouteSeedingsTx(tx, target),
    );
    for (const route of seedings === null ? [] : seedings.routes) {
      write(
        route.state === "seeded"
          ? `  ${route.indexId}: seeded by pass ${String(route.passNumber)} (${route.jurisdictions.join(", ")})`
          : `  ${route.indexId}: unseeded, ${route.reason} (${route.jurisdictions.join(", ")})`,
      );
    }
    return seedRunExit({
      target,
      paused: ran.paused,
      outcome,
      seedings,
      write,
    });
  });
};

const PROVE_EXIT = {
  current: 0,
  budgetSpent: 5,
  braked: 6,
  lockUnavailable: 7,
  setAside: 8,
  failed: 9,
} as const;

/** The exit code a proof run ends with, and the line that says why. */
const proveRunExit = (
  run: Extract<CorpusIndexRouteProofRun, { type: "ran" }>,
): { code: number; line: string } => {
  if ([...run.proofs.values()].every(({ type }) => type === "all_current")) {
    return {
      code: PROVE_EXIT.current,
      line: "every route of every proven generation is current",
    };
  }
  const { stop } = run;
  switch (stop.type) {
    case "all_current":
    case "budget_spent":
      return run.routes.some(({ setAside }) => setAside !== null)
        ? {
            code: PROVE_EXIT.setAside,
            line: "a route is set aside (see above); fix it, then rerun",
          }
        : {
            code: PROVE_EXIT.budgetSpent,
            line: "hours spent with a route not current; rerun to resume from the stored passes",
          };
    case "nothing_to_walk":
      return {
        code: PROVE_EXIT.setAside,
        line: "every route not current is set aside (see above); nothing was left to walk",
      };
    case "braked":
      return {
        code: PROVE_EXIT.braked,
        line: "paused by the database-load brake; rerun to resume",
      };
    case "lock_unavailable":
      return {
        code: PROVE_EXIT.lockUnavailable,
        line: "locks stayed refused (a flip holds the projection fence); rerun after it",
      };
    case "failed":
      return {
        code: PROVE_EXIT.failed,
        line: `${stop.route.generation}/${stop.route.indexId} failed ${String(stop.failures)} times in a row; rerun to resume`,
      };
    default:
      stop satisfies never;
      return panic(`Unhandled proof run stop: ${String(stop)}`);
  }
};

const describeProofs = (
  run: Extract<CorpusIndexRouteProofRun, { type: "ran" }>,
): string[] =>
  [...run.proofs].flatMap(([generation, proofs]) => {
    switch (proofs.type) {
      case "all_current":
        return proofs.routes.map(
          ({ indexId, inspected }) =>
            `  ${generation}/${indexId}: current (${String(inspected)} revisions)`,
        );
      case "not_ready":
        return proofs.routes.map(
          ({ indexId, status }) => `  ${generation}/${indexId}: ${status.type}`,
        );
      case "generation_absent":
      case "open_route_set":
        return [`  ${generation}: ${proofs.type}`];
      default:
        proofs satisfies never;
        return panic("Unhandled route proofs reading");
    }
  });

/**
 * Walk the route proofs of the generation, and unless `--only-requested` the
 * serving one and the kept one, until the hours are spent or, with
 * `--until-current`, every route is current (`runCorpusIndexRouteProofs`). Every page records
 * its pass in the database, so a stopped or crashed run resumes there.
 */
const runProve = async (
  { withProofDatabase, proofBrake, proofClient, write }: CommandContext,
  {
    target,
    hours,
    untilCurrent,
    onlyRequested,
    concurrency,
  }: Extract<CorpusGenerationCommand, { type: "prove" }>,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  write(
    `prove ${target.family}/${target.generation} (at most ${String(hours)} h${untilCurrent ? ", until every route is current" : ""}${onlyRequested ? ", this generation only" : ""})`,
  );
  write(declaredLine(target));
  const budgetMs = hours * 3_600_000;
  const now = () => Temporal.Now.instant().epochMilliseconds;
  const endsAt = now() + budgetMs;
  const run = await withProofDatabase(budgetMs, async (runInTransaction) => {
    const brake = createCorpusIndexRouteProofBrake({
      readDecision: async () => await proofBrake.readDecision(runInTransaction),
      maxWaitMs: proofBrake.maxWaitMs,
      recheckMs: PROVE_LOAD_RECHECK_MS,
      now,
      sleep: Bun.sleep,
    });
    return await runCorpusIndexRouteProofs({
      runInTransaction,
      clientFor: ({ family, generation }) =>
        proofClient(requireCorpusIndexManifest(family, generation)),
      admit: brake.admit,
      pace: brake.pace,
      target,
      budget: { endsAt, pages: PROVE_MAX_PAGES },
      onlyRequested,
      untilCurrent,
      concurrency,
      fencePatienceMs: PROVE_PATIENCE_MS,
      now,
      sleep: Bun.sleep,
      write,
    });
  });
  if (run.type === "refused") {
    return Result.err(
      new CorpusGenerationRetiringError({
        message: `${target.family}/${run.generation} is ${run.status ?? "not registered"}; only a building or serving generation is proven`,
        family: target.family,
        generation: run.generation,
      }),
    );
  }
  for (const report of run.routes) {
    write(
      `  ${report.route.generation}/${report.route.indexId}: ${String(report.pages)} pages, ${String(report.proofs)} proofs, ${String(report.repairs)} drift repairs this run`,
    );
  }
  for (const line of describeProofs(run)) {
    write(line);
  }
  const exit = proveRunExit(run);
  write(exit.line);
  return Result.ok(exit.code);
};

/** Exit codes of `retire`, one per class of refusal, so a wrapper can tell them apart. */
const RETIRE_EXIT = {
  done: 0,
  braked: 6,
  registry: 10,
  flip: 11,
  pointer: 12,
  inFlight: 13,
  busy: 14,
  engine: 15,
} as const;

const retireExitCode = ({ class: refusalClass }: CorpusIndexRetireRefusal) => {
  switch (refusalClass) {
    case "registry":
      return RETIRE_EXIT.registry;
    case "flip":
      return RETIRE_EXIT.flip;
    case "pointer":
      return RETIRE_EXIT.pointer;
    case "in_flight":
      return RETIRE_EXIT.inFlight;
    case "busy":
      return RETIRE_EXIT.busy;
    default:
      refusalClass satisfies never;
      return panic(`Unhandled retire refusal: ${String(refusalClass)}`);
  }
};

const describeRetired = (
  decision: Extract<CorpusIndexRetireDecision, { type: "already_retired" }>,
): string =>
  decision.receipt === null
    ? "checked: already retired (before the retire command recorded receipts); its cleanup resumes"
    : `checked: already retired at ${decision.receipt.retiredAt.toISOString()} by ${decision.receipt.retireActor} (${decision.receipt.retireReason}); its cleanup resumes`;

type RetireCommand = Extract<CorpusGenerationCommand, { type: "retire" }>;

const retireRefused = (
  { writeError }: CommandContext,
  error: CorpusIndexGenerationRetireRefusedError,
) => {
  writeError(
    `refused (${error.refusal.class}: ${error.refusal.reason}): ${error.message}`,
  );
  for (const line of error.details) {
    writeError(`  ${line}`);
  }
  return Result.ok(retireExitCode(error.refusal));
};

const readRetireDecision = async (
  { withDatabase }: CommandContext,
  target: DeclaredTarget,
) =>
  await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await withAggregateTransaction(
        rootDb,
        async (tx) => await readCorpusIndexRetireTx(tx, target),
      ),
  );

/** One line saying how much history the generation holds; a failed count says so. */
const retireHistoryLine = async (
  { withDatabase }: CommandContext,
  target: DeclaredTarget,
  label: string,
): Promise<string> => {
  const history = await Result.tryPromise({
    try: async () =>
      await withDatabase(
        ACCESS.read,
        async (rootDb) =>
          await withAggregateTransaction(
            rootDb,
            async (tx) => await countCorpusIndexGenerationHistoryTx(tx, target),
          ),
      ),
    catch: (cause) => cause,
  });
  if (history.isErr()) {
    return `${label}: unavailable (${history.error instanceof Error ? history.error.message : String(history.error)})`;
  }
  if (history.value.isErr()) {
    return `${label}: unavailable (${history.value.error.message})`;
  }
  const { states, intents } = history.value.value;
  return `${label}: ${String(states)} projection states, ${String(intents)} revisions`;
};

/** The fenced transition, on the bounded lane; null when it went through. */
const applyRetireTransition = async (
  context: CommandContext,
  {
    target,
    receipt,
  }: RetireCommand & { receipt: { actor: string; reason: string } },
): Promise<Result<number | null, CorpusGenerationRefusal>> => {
  // The lane can run out of time after the retire's transaction ended; the
  // retire's own answer, kept here, then still says whether it committed.
  const settled: {
    value?: Awaited<ReturnType<typeof retireCorpusIndexGeneration>>;
  } = {};
  const lane = await Result.tryPromise({
    try: async () =>
      await context.withDatabase(ACCESS.write, async (rootDb) => {
        settled.value = await retireCorpusIndexGeneration(
          async (work) => await withAggregateTransaction(rootDb, work),
          target,
          receipt,
        );
        return settled.value;
      }),
    catch: (cause) => cause,
  });
  if (lane.isOk() && lane.value.isErr()) {
    return Result.err(lane.value.error);
  }
  const retired = settled.value;
  if (retired === undefined) {
    if (lane.isOk()) {
      return panic("The retire lane returned without the retire's answer");
    }
    const busy = corpusIndexFlipBusyReasonOf(lane.error);
    if (busy === null) {
      return panic("The retire lane failed before the retire ran", lane.error);
    }
    context.writeError(
      `refused (busy: ${busy}): the lane or the database declined the retire its time before it ran; nothing changed, retry`,
    );
    return Result.ok(RETIRE_EXIT.busy);
  }
  if (lane.isErr()) {
    context.writeError(
      "note: the operator lane's time budget ran out after the retire's transaction ended; its outcome below stands",
    );
  }
  if (retired.isErr()) {
    return retireRefused(context, retired.error);
  }
  context.write(
    retired.value.type === "retired"
      ? `Applied: ${target.family}/${target.generation} is retired as of ${retired.value.retiredAt.toISOString()}.`
      : `checked: ${target.family}/${target.generation} was retired meanwhile.`,
  );
  return Result.ok(null);
};

/**
 * Delete the projection history of a retired generation page by page under
 * the database-load brake, then record what the run deleted. The page
 * runtime keeps the cursor, so a run that stops resumes where it stopped.
 */
const purgeRetiredHistory = async (
  context: CommandContext,
  target: DeclaredTarget,
  deletedIndexes: number,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  const { withSeedingDatabase, seedingBrake, write, writeError } = context;
  return await withSeedingDatabase(async (rootDb) => {
    const runtime = seedingBrake.createRuntime({
      name: `corpus-retire:${target.family}:${target.generation}`,
      tableName: "corpus_index_projection_states",
      initialSize: RETIRE_PAGE_LIMIT,
      db: rootDb,
    });
    const deleted = { pages: 0, states: 0, intents: 0 };
    const ran: { paused: boolean; lockWait: BackfillLockWaitError | null } = {
      paused: false,
      lockWait: null,
    };
    try {
      const pass = await runBackfillPass({
        step: async () =>
          await runtime.step(async ({ tx, size, cursor }) => {
            const page = await purgeRetiredCorpusIndexGenerationPageTx(
              tx,
              target,
              {
                after: cursor,
                limit: Math.max(1, Math.min(size, RETIRE_PAGE_LIMIT)),
              },
            );
            return { cursor: page.last, done: page.last === null, value: page };
          }),
        onBatch: ({ value }) => {
          if (value.last === null) {
            return;
          }
          deleted.pages += 1;
          deleted.states += value.deletedStates;
          deleted.intents += value.deletedIntents;
          if (deleted.pages % RETIRE_PROGRESS_EVERY_PAGES === 0) {
            write(
              `  page ${String(deleted.pages)}: ${String(deleted.states)} states, ${String(deleted.intents)} revisions deleted, through ${value.last}`,
            );
          }
        },
        sleep: Bun.sleep,
        maxWaitMs: seedingBrake.maxWaitMs,
        maxLockWaitMs: seedingBrake.maxLockWaitMs,
        log: pageWaitLog(write),
      });
      if (pass.isErr()) {
        if (!(pass.error instanceof BackfillLockWaitError)) {
          throw pass.error;
        }
        ran.lockWait = pass.error;
      } else {
        ran.paused = pass.value.status === "paused";
      }
    } finally {
      await runtime.close();
      await withAggregateTransaction(
        rootDb,
        async (tx) =>
          await recordCorpusIndexRetireCleanupTx(tx, {
            indexes: deletedIndexes,
            states: deleted.states,
            intents: deleted.intents,
          }),
      );
    }
    write(
      `deleted this run: ${String(deleted.states)} projection states, ${String(deleted.intents)} revisions in ${String(deleted.pages)} pages`,
    );
    write(await retireHistoryLine(context, target, "left"));
    if (ran.lockWait !== null) {
      writeError(
        `busy: ${lockWaitStopLine(ran.lockWait, seedingBrake.maxLockWaitMs)}`,
      );
      return Result.ok(RETIRE_EXIT.busy);
    }
    if (ran.paused) {
      writeError(
        "paused: the database-load brake held the cleanup; run retire again to resume",
      );
      return Result.ok(RETIRE_EXIT.braked);
    }
    write(
      `Applied: the projection history of ${target.family}/${target.generation} is gone.`,
    );
    return Result.ok(RETIRE_EXIT.done);
  });
};

/**
 * End a `--defer-cleanup` run: record the indexes it deleted and say that the
 * history stays for a later run. The generation is retired, so no writer adds
 * to that history meanwhile; a later `retire` of it goes straight to the
 * cleanup.
 */
const deferRetiredHistory = async (
  context: CommandContext,
  target: DeclaredTarget,
  {
    deletedIndexes,
    engineFailure,
  }: { deletedIndexes: number; engineFailure: string | null },
): Promise<Result<number, CorpusGenerationRefusal>> => {
  if (deletedIndexes > 0) {
    await context.withSeedingDatabase(
      async (rootDb) =>
        await withAggregateTransaction(
          rootDb,
          async (tx) =>
            await recordCorpusIndexRetireCleanupTx(tx, {
              indexes: deletedIndexes,
              states: 0,
              intents: 0,
            }),
        ),
    );
  }
  context.write(await retireHistoryLine(context, target, "left"));
  context.write(
    `Deferred: history cleanup of ${target.family}/${target.generation} is left for a later run; run retire again without --defer-cleanup to delete it.`,
  );
  if (engineFailure !== null) {
    context.writeError(`refused (engine): ${engineFailure}; run retire again`);
    return Result.ok(RETIRE_EXIT.engine);
  }
  return Result.ok(RETIRE_EXIT.done);
};

const runRetire = async (
  context: CommandContext,
  command: RetireCommand,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  const { target, mode, receipt } = command;
  const { write, writeError } = context;
  write(`retire ${target.family}/${target.generation} (${mode})`);
  write(declaredLine(target));
  if (context.searchEndpoint(target.manifest) === null) {
    return Result.err(
      new CorpusGenerationSearchEndpointMissingError({
        message: `No search endpoint is configured for cluster ${target.manifest.cluster}; the indexes cannot be listed`,
      }),
    );
  }
  const read = await readRetireDecision(context, target);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  if (read.value.isErr()) {
    return retireRefused(context, read.value.error);
  }
  const decision = read.value.value;
  write(
    decision.type === "already_retired"
      ? describeRetired(decision)
      : `plan: ${target.generation} building -> retired; no writer projects it from that commit on`,
  );
  write(await retireHistoryLine(context, target, "holds"));
  const engine = context.retireEngine(target.manifest);
  const listed = await engine.readPublishedSplitCounts({
    includes: (indexId) =>
      corpusIndexBelongsToGeneration(target.generation, indexId),
    observer: "unobserved",
  });
  if (listed.isErr()) {
    writeError(
      `engine: the engine did not list the indexes of ${target.generation}: ${listed.error.message}`,
    );
    // A dry run stops here. An apply goes on: the retire and the history
    // need no engine, and the engine step reports its own failure.
    if (mode === MODES.dryRun || receipt === null) {
      return Result.ok(RETIRE_EXIT.engine);
    }
  } else {
    write(
      listed.value.length === 0
        ? "plan: the engine holds no index of this generation"
        : `plan: delete ${String(listed.value.length)} engine indexes: ${listed.value
            .map(
              ({ indexId, publishedSplits }) =>
                `${indexId} (${String(publishedSplits)} splits)`,
            )
            .join(", ")}`,
    );
  }
  write(
    command.deferCleanup
      ? "plan: leave its projection history for a later run of retire (--defer-cleanup)"
      : `plan: delete its projection history in pages of at most ${String(RETIRE_PAGE_LIMIT)} decisions, under the database-load brake`,
  );
  if (mode === MODES.dryRun || receipt === null) {
    write(modeLine(MODES.dryRun, ""));
    return Result.ok(RETIRE_EXIT.done);
  }
  if (decision.type === "retire") {
    const transition = await applyRetireTransition(context, {
      ...command,
      receipt,
    });
    if (transition.isErr()) {
      return Result.err(transition.error);
    }
    if (transition.value !== null) {
      return Result.ok(transition.value);
    }
  }
  // The engine and the history only once the registry says retired: from
  // then on nothing serves the generation and no writer may touch it.
  const again = await readRetireDecision(context, target);
  if (again.isErr()) {
    return Result.err(again.error);
  }
  if (again.value.isErr() || again.value.value.type !== "already_retired") {
    return panic(
      `${target.family}/${target.generation} is not retired after the retire committed`,
    );
  }
  const indexes = await deleteRetiredCorpusIndexGenerationIndexes({
    engine,
    target,
  });
  const deletedIndexes = indexes.isErr()
    ? indexes.error.deleted
    : indexes.value.deleted;
  for (const indexId of deletedIndexes) {
    write(`  deleted engine index ${indexId}`);
  }
  if (indexes.isOk()) {
    write(
      `Applied: the engine holds no index of ${target.generation} (${String(deletedIndexes.length)} deleted).`,
    );
  }
  if (command.deferCleanup) {
    return await deferRetiredHistory(context, target, {
      deletedIndexes: deletedIndexes.length,
      engineFailure: indexes.isErr() ? indexes.error.message : null,
    });
  }
  // The history goes either way: nothing reads it once the generation is
  // retired, and an engine that is down only delays its own step.
  const purged = await purgeRetiredHistory(
    context,
    target,
    deletedIndexes.length,
  );
  if (indexes.isErr()) {
    writeError(`refused (engine): ${indexes.error.message}; run retire again`);
    return purged.isErr() ? purged : Result.ok(RETIRE_EXIT.engine);
  }
  return purged;
};

/** States one wake batch takes at most: a few hundred row locks and probes. */
const WAKE_BATCH_STATES = 500;
/** Batches one run takes at most; a larger backlog is finished by a rerun. */
const WAKE_MAX_BATCHES = 60;

type WakeProgress = { woken: number; busy: boolean };

/**
 * Wakes owed states one committed batch at a time, recursing while batches
 * come back full and at most `batchesLeft` more times; a larger backlog is
 * finished by a rerun. A batch that meets a held row lock stops the run as
 * busy with what earlier batches already woke.
 */
const wakeDeferredBatches = async (
  rootDb: CaseLawRootHandle,
  wake: DeferredWakeTarget,
  batchesLeft: number,
): Promise<WakeProgress> => {
  if (batchesLeft <= 0) {
    return { woken: 0, busy: false };
  }
  const step = await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(
        rootDb,
        async (tx) =>
          await wakeDeferredAppendStatesBatchTx(tx, wake, WAKE_BATCH_STATES),
      ),
    catch: (cause) => cause,
  });
  if (step.isErr()) {
    if (getPgErrorCode(step.error) === PG_ERROR.LOCK_NOT_AVAILABLE) {
      return { woken: 0, busy: true };
    }
    return panic("A deferred-state wake batch failed", step.error);
  }
  if (step.value < WAKE_BATCH_STATES) {
    return { woken: step.value, busy: false };
  }
  const rest = await wakeDeferredBatches(rootDb, wake, batchesLeft - 1);
  return { woken: step.value + rest.woken, busy: rest.busy };
};

const deferredLine = (
  label: string,
  { count, idsSha256 }: DeferredAppendStates,
) => `${label}: ${String(count)} deferred state(s), ids sha256 ${idsSha256}`;

const runWakeDeferred = async (
  { withDatabase, write }: CommandContext,
  {
    target,
    wake,
    mode,
  }: Extract<CorpusGenerationCommand, { type: "wake-deferred" }>,
): Promise<Result<number, CorpusGenerationRefusal>> => {
  write(`wake-deferred ${target.family}/${target.generation} (${mode})`);
  write(declaredLine(target));
  const before = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await withAggregateTransaction(
        rootDb,
        async (tx) => await readDeferredAppendStatesTx(tx, wake),
      ),
  );
  if (before.isErr()) {
    return Result.err(before.error);
  }
  write(deferredLine("owed", before.value));
  if (mode === MODES.dryRun || before.value.count === 0) {
    write(modeLine(mode, "applied: nothing owed"));
    return Result.ok(0);
  }
  const applied = await withDatabase(
    ACCESS.write,
    async (rootDb) => await wakeDeferredBatches(rootDb, wake, WAKE_MAX_BATCHES),
  );
  if (applied.isErr()) {
    return Result.err(applied.error);
  }
  write(`applied: woke ${String(applied.value.woken)} state(s)`);
  const after = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await withAggregateTransaction(
        rootDb,
        async (tx) => await readDeferredAppendStatesTx(tx, wake),
      ),
  );
  if (after.isErr()) {
    return Result.err(after.error);
  }
  write(deferredLine("left", after.value));
  if (applied.value.busy) {
    write(
      `a lock stayed held past ${String(DEFERRED_WAKE_LOCK_TIMEOUT_MS)} ms (a flip holds the projection fence); rerun`,
    );
    return Result.ok(14);
  }
  if (after.value.count > 0) {
    write(
      "the states left were held by a writer when their batch ran, or past this run's batch cap; rerun",
    );
    return Result.ok(7);
  }
  return Result.ok(0);
};

type RunCorpusGenerationOptions = {
  args: readonly string[];
  withDatabase?: WithCorpusDatabase;
  withSeedingDatabase?: WithSeedingDatabase;
  seedingBrake?: SeedingBrake;
  withProofDatabase?: WithProofDatabase;
  proofBrake?: ProofBrake;
  proofClient?: CommandContext["proofClient"];
  indexClient?: (manifest: CorpusIndexManifest) => CorpusIndexFlipEngine;
  retireEngine?: (manifest: CorpusIndexManifest) => CorpusIndexRetireEngine;
  searchEndpoint?: (manifest: CorpusIndexManifest) => string | null;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
};

/** Run one command; resolves with the process exit code. */
export const runCorpusGenerationCommand = async ({
  args,
  withDatabase = withOperatorDatabase,
  withSeedingDatabase = withSeedingLane,
  seedingBrake = SEEDING_BRAKE,
  withProofDatabase = withProofSession,
  proofBrake = PROOF_BRAKE,
  proofClient = (manifest) => getCorpusIndexClient(manifest.cluster),
  indexClient = (manifest) => getCorpusIndexClient(manifest.cluster),
  retireEngine = (manifest) => getCorpusIndexClient(manifest.cluster),
  searchEndpoint = (manifest) => readCorpusIndexSearchBaseUrl(manifest.cluster),
  write = (line) => process.stdout.write(`${line}\n`),
  writeError = (line) => process.stderr.write(`${line}\n`),
}: RunCorpusGenerationOptions): Promise<number> => {
  if (args.length === 1 && args.at(0) === "--help") {
    write(USAGE);
    return 0;
  }
  const command = parseCorpusGenerationCommand(args);
  if (command.isErr()) {
    writeError(`refused (${command.error._tag}): ${command.error.message}`);
    if (command.error._tag === "CorpusGenerationUsageError") {
      writeError(USAGE);
    }
    return 1;
  }
  const context: CommandContext = {
    withDatabase,
    withSeedingDatabase,
    seedingBrake,
    withProofDatabase,
    proofBrake,
    proofClient,
    indexClient,
    retireEngine,
    searchEndpoint,
    write,
    writeError,
  };
  const outcome = await (async () => {
    switch (command.value.type) {
      case "status":
        return await runStatus(context);
      case "register":
        return await runRegister(context, command.value);
      case "serve":
        return await runServe(context, command.value);
      case "parity":
        return await runParity(context, command.value);
      case "seed":
        return await runSeed(context, command.value);
      case "prove":
        return await runProve(context, command.value);
      case "retire":
        return await runRetire(context, command.value);
      case "wake-deferred":
        return await runWakeDeferred(context, command.value);
      default:
        command.value satisfies never;
        return panic(`Unhandled command: ${String(command.value)}`);
    }
  })();
  if (outcome.isErr()) {
    writeError(`refused (${outcome.error._tag}): ${outcome.error.message}`);
    return 1;
  }
  return outcome.value ?? 0;
};

if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    // The door's connections stay open otherwise.
    process.exit(
      await runCorpusGenerationCommand({ args: process.argv.slice(2) }),
    );
  });
}

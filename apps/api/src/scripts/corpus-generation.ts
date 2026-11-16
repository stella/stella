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
 *
 * `serve` runs the guarded flip (`corpus-index-generation-flip.ts`), the one
 * owner of the decision: phase 1 reads the engine and walks the parity
 * coverage with no lock held, phase 2 re-checks everything PostgreSQL holds
 * under the activation and exclusive projection fences, refusing rather than
 * waiting, then swaps the pair and writes the receipt. The generation it
 * replaces stays building, so `serve` with the pair reversed flips back
 * through the same guard. A dry run (the default) takes the same transaction
 * and fences and swaps nothing; it holds projection writers back for as long
 * as its checks under the fence take (seconds).
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
 * budget is spent.
 */
import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";
import { Temporal } from "@stll/time";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  type CaseLawRootHandle,
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
  type CorpusIndexFlipEngine,
  type CorpusIndexFlipOutcome,
  type CorpusIndexFlipPlan,
  type CorpusIndexFlipRefusal,
  type CorpusIndexGenerationFlipRefusedError,
  prepareCorpusIndexGenerationFlip,
  runCorpusIndexGenerationFlip,
} from "@/api/lib/legal-search/corpus-index-generation-flip";
import {
  lockCorpusIndexGenerationActivationTx,
  registerCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  type CorpusIndexManifest,
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS } from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import {
  advanceCorpusIndexGenerationSeedingTx,
  type CorpusIndexSeedingAdvance,
  readCorpusIndexRouteSeedingsTx,
} from "@/api/lib/legal-search/corpus-index-route-seeding";
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

const USAGE = `Usage: bun run src/scripts/corpus-generation.ts <command> [options]

Commands:
  status                 Print every registered generation of every family.
  register               Register a declared generation as building.
  serve                  Flip the family's serving generation to a building one,
                         guarded by parity, route proofs, seeding and engine
                         counts; the one it replaces stays building, so the
                         same command flips back.
  parity                 Report what readers would lose if the generation
                         replaced the one serving its family. Reads only.
  seed                   Walk the generation's seeding pass, giving every
                         canonical row a desired state, until every route
                         is seeded or the page budget is spent. Resumable.

Options (register, serve, parity, seed):
  --family <family>      ${CORPUS_FAMILIES.join(" | ")}
  --generation <name>    A generation declared in code, e.g. case_law_v7.
  --apply                Perform the change. Omitted, the run only reports.
  --dry-run              Report only, the default; contradicts --apply.

Options (serve):
  --replacing <g|none>   The generation the flip replaces, as the operator expects
                         it; required with --apply.
  --actor <id>           Who makes the flip, for its receipt; required with --apply.
  --reason <text>        Why (the go it rests on), for its receipt; required with --apply.
  --max-proof-age-hours <n>
                         Oldest route proof accepted, from its pass's start
                         (default and most ${String(CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS)}).

Options (serve, parity):
  --exempt-minutes <n>   Serving applies newer than this many minutes are the
                         candidate's expected lag (default ${String(PARITY_DEFAULT_EXEMPT_MINUTES)}).
  --coverage-pages <n>   Coverage pages of ${String(PARITY_COVERAGE_PAGE)} serving copies to read
                         (default ${String(PARITY_DEFAULT_COVERAGE_PAGES)}, at most ${String(PARITY_MAX_COVERAGE_PAGES)}); a walk
                         that does not reach the end leaves the verdict undecided.

Options (parity):
  --coverage-from <e>    Resume a walk after serving entity e (or "start");
                         a resumed walk never proves the verdict.
  --list                 Also print up to 50 decisions of each kind by id.

Options (seed):
  --pages <n>            Pages of ${String(SEED_PAGE_LIMIT)} canonical rows to walk (default
                         ${String(SEED_DEFAULT_PAGES)}, at most ${String(SEED_MAX_PAGES)}); the next run resumes.

Exit codes (serve): 0 flipped (or, dry run, every check passed), 3 parity
regressions, 4 undecided, 10 registry, 11 route proofs, 12 seeding, 13 engine
evidence, 14 busy (a fence or read timed out; nothing changed), 1 refused.
Exit codes (parity): 0 no regression, 3 regressions, 4 undecided, 1 refused.
Exit codes (seed): 0 every route seeded, 5 page budget spent, 6 paused by
the database-load brake (after 15 minutes of waiting), 7 next row held by a
writer, 8 a route appeared after the pass began, 1 refused.
`;

/** Rows `status` and the planners read; the registry holds a handful per family. */
const REGISTRY_READ_LIMIT = 200;
/** Budget for the whole write: lane, re-check, flip, audit. */
const APPLY_TIMEOUT_MS = 60_000;
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
  | { type: "seed"; target: DeclaredTarget; pages: number };

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
  const serveOptions =
    values.replacing !== undefined ||
    values.actor !== undefined ||
    values.reason !== undefined ||
    values["max-proof-age-hours"] !== undefined;
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
  if (name !== "serve" && serveOptions) {
    return "--replacing, --actor, --reason and --max-proof-age-hours belong to serve.";
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
      "Name exactly one command: status, register, serve, parity or seed.",
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
      return parseServeCommand(target.value, mode, values, {
        exemptMinutes,
        coveragePages,
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
      // Bounded: a busy lane refuses instead of queueing a flip for hours
      // behind another operator pass.
      const ran = await enterCaseLawMaintenanceLane({
        mode: "bounded",
        signal: AbortSignal.timeout(APPLY_TIMEOUT_MS),
        statementTimeout: APPLY_QUERY_TIMEOUT_MS,
        lockTimeout: APPLY_QUERY_TIMEOUT_MS,
        work: async ({ rootDb }) => ({ value: await work(rootDb) }),
      });
      return ran === null
        ? Result.err(
            new CorpusGenerationLaneBusyError({
              message:
                "Another case-law maintenance pass holds the lane; retry once it finishes",
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
};

const SEEDING_BRAKE: SeedingBrake = {
  createRuntime: createScriptBackfillRuntime,
  maxWaitMs: 15 * 60_000,
};

type CommandContext = {
  withDatabase: WithCorpusDatabase;
  withSeedingDatabase: WithSeedingDatabase;
  seedingBrake: SeedingBrake;
  indexClient: (manifest: CorpusIndexManifest) => CorpusIndexFlipEngine;
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
      `checked: ${indexId} holds ${String(engine)} documents; its ${String(appliedRevisions)} applied revisions expect ${String(expected)}`,
  ),
  ...(plan.walk === null
    ? []
    : [
        `checked: coverage walk read every state of ${plan.walk.pair.serving} (${String(plan.walk.coverage.walked)}); none without a state in ${plan.request.candidate}`,
      ]),
];

/** What phase 2 decided under the fence, line by line. */
const describeOutcome = (
  outcome: Exclude<CorpusIndexFlipOutcome, { type: "already_serving" }>,
): string[] => {
  const { evidence } = outcome;
  return [
    ...(evidence.parity === null
      ? []
      : [
          `checked under the fence: no regression against ${evidence.from ?? "(none)"}; tail ${evidence.parity.tail.type === "read" ? `${String(evidence.parity.tail.walked)} states read` : evidence.parity.tail.type}; walked ${String(evidence.parity.walked.pending)} pending, ${String(evidence.parity.walked.blocked)} blocked, ${String(evidence.parity.walked.absent)} proven gone, ${String(evidence.parity.walked.atRisk)} with a delete in flight; ${String(evidence.parity.exempt)} exempt as lag younger than ${evidence.parity.watermark}`,
        ]),
    `checked under the fence: ${String(evidence.routeProofs.length)} route proofs current and unchanged since the engine was read`,
    `checked under the fence: every route of ${evidence.to} seeded (${evidence.seedings.candidate.map(({ indexId, passNumber }) => `${indexId} pass ${String(passNumber)}`).join(", ")})`,
    ...(evidence.seedings.serving === null
      ? []
      : [
          `checked under the fence: every route of ${evidence.from ?? "(none)"} seeded (${evidence.seedings.serving.map(({ indexId, passNumber }) => `${indexId} pass ${String(passNumber)}`).join(", ")})`,
        ]),
    `evidence digest: ${outcome.evidenceDigest}`,
  ];
};

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
  // run, which takes the same fences and writes nothing.
  const decided = await withDatabase(
    ACCESS.write,
    async (rootDb) =>
      await runCorpusIndexGenerationFlip(
        async (work) => await withAggregateTransaction(rootDb, work),
        plan,
        mode === MODES.apply && command.receipt !== null
          ? { mode: "apply", ...command.receipt }
          : { mode: "dry_run" },
      ),
  );
  if (decided.isErr()) {
    return Result.err(decided.error);
  }
  if (decided.value.isErr()) {
    return refused(decided.value.error);
  }
  const outcome = decided.value.value;
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
        `Applied: ${target.family}/${target.generation} serves${outcome.evidence.from === null ? "" : `; ${outcome.evidence.from} is building and can serve again through the same guard`}. Receipt ${outcome.receiptId ?? "-"}.`,
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
  /** A writer holds the next row; rerun once it commits. */
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
    const ran: { paused: boolean } = { paused: false };
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
      });
      if (pass.isErr()) {
        throw pass.error;
      }
      ran.paused = pass.value.status === "paused";
    } finally {
      await runtime.close();
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

type RunCorpusGenerationOptions = {
  args: readonly string[];
  withDatabase?: WithCorpusDatabase;
  withSeedingDatabase?: WithSeedingDatabase;
  seedingBrake?: SeedingBrake;
  indexClient?: (manifest: CorpusIndexManifest) => CorpusIndexFlipEngine;
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
  indexClient = (manifest) => getCorpusIndexClient(manifest.cluster),
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
    indexClient,
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

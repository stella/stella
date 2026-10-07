/**
 * The operator command for the corpus generation registry: which generation
 * of each corpus family is registered, and which one serves.
 *
 *   bun run src/scripts/corpus-generation.ts status
 *   bun run src/scripts/corpus-generation.ts register --family case_law --generation case_law_v7 [--apply]
 *   bun run src/scripts/corpus-generation.ts serve --family case_law --generation case_law_v7 [--apply]
 *
 * `serve` is the primary path; generations are normally registered by the
 * projection coordinator, and `register` covers an environment that has none.
 * Both mutating subcommands report the planned transition and every
 * precondition they checked, and write only under `--apply`, in one
 * transaction that re-checks the registry under a row lock and records a
 * system audit run. The state machine itself is the generation store's
 * (`corpus-index-generation-store.ts`); this command adds the refusals an
 * operator needs to read, and the one precondition the store cannot check:
 * that the target's indexes exist and hold documents on the search endpoint
 * readers will query. Flipping to a generation whose index set is empty would
 * answer every search with no results rather than with an error.
 */

import { Result, TaggedError, panic } from "better-result";
import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
  type CaseLawRootHandle,
} from "@/api/lib/case-law/maintenance-lane";
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
  registerCorpusIndexGenerationTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexReadContract } from "@/api/lib/legal-search/corpus-index-read-contract";
import { corpusIndexPattern } from "@/api/lib/legal-search/index-naming";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const USAGE = `Usage: bun run src/scripts/corpus-generation.ts <command> [options]

Commands:
  status                 Print every registered generation of every family.
  register               Register a declared generation as building.
  serve                  Make a registered generation the one its family serves;
                         the generation serving before it becomes retiring.

Options (register, serve):
  --family <family>      ${CORPUS_FAMILIES.join(" | ")}
  --generation <name>    A generation declared in code, e.g. case_law_v7.
  --apply                Perform the change. Omitted, the run only reports.
  --dry-run              Report only, the default; contradicts --apply.
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

class CorpusGenerationNotRegisteredError extends TaggedError(
  "CorpusGenerationNotRegisteredError",
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

class CorpusGenerationIndexMissingError extends TaggedError(
  "CorpusGenerationIndexMissingError",
)<{ message: string; indexId: string }> {}

class CorpusGenerationIndexEmptyError extends TaggedError(
  "CorpusGenerationIndexEmptyError",
)<{ message: string; indexId: string }> {}

class CorpusGenerationIndexUnreadableError extends TaggedError(
  "CorpusGenerationIndexUnreadableError",
)<{ message: string; indexId: string; cause: unknown }> {}

export class CorpusGenerationLaneBusyError extends TaggedError(
  "CorpusGenerationLaneBusyError",
)<{ message: string }> {}

type RegistryRefusal =
  | CorpusGenerationNotRegisteredError
  | CorpusGenerationRetiringError
  | CorpusGenerationRetiredError
  | CorpusGenerationContractMismatchError;

type IndexRefusal =
  | CorpusGenerationSearchEndpointMissingError
  | CorpusGenerationIndexMissingError
  | CorpusGenerationIndexEmptyError
  | CorpusGenerationIndexUnreadableError;

type CorpusGenerationRefusal =
  | CorpusGenerationUsageError
  | CorpusGenerationUndeclaredError
  | RegistryRefusal
  | IndexRefusal
  | CorpusGenerationLaneBusyError;

/** A target the code declares, with the manifest it is bound to. */
type DeclaredTarget = GenerationTarget & {
  manifest: CorpusIndexManifest;
  manifestDigest: string;
};

type CorpusGenerationCommand =
  | { type: "status" }
  | { type: "register"; target: DeclaredTarget; mode: Mode }
  | { type: "serve"; target: DeclaredTarget; mode: Mode };

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

const COMMAND_NAMES = ["status", "register", "serve"] as const;

const usageError = (message: string) =>
  Result.err(new CorpusGenerationUsageError({ message }));

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
    return usageError("Name exactly one command: status, register or serve.");
  }
  if (values.apply === true && values["dry-run"] === true) {
    return usageError("--apply and --dry-run contradict each other; pass one.");
  }
  if (name === "status") {
    return values.family === undefined &&
      values.generation === undefined &&
      values.apply !== true
      ? Result.ok({ type: "status" })
      : usageError("status takes no options.");
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
  switch (name) {
    case "register":
      return Result.ok({ type: "register", target: target.value, mode });
    case "serve":
      return Result.ok({ type: "serve", target: target.value, mode });
    default:
      name satisfies never;
      return panic(`Unhandled command: ${String(name)}`);
  }
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

type ServePlan =
  | {
      type: "promote";
      target: DeclaredTarget;
      /** The generation serving now, which becomes retiring; null on a first flip. */
      demotes: string | null;
    }
  | { type: "already_serving"; target: DeclaredTarget };

/** What `serve` would do to the registry as `rows` holds it. */
const planServe = (
  rows: readonly GenerationRow[],
  target: DeclaredTarget,
): Result<ServePlan, RegistryRefusal> => {
  const row = rows.find(({ generation }) => generation === target.generation);
  if (row === undefined) {
    return Result.err(
      new CorpusGenerationNotRegisteredError({
        message: `${target.family}/${target.generation} is not registered; register it and let it build first`,
        family: target.family,
        generation: target.generation,
      }),
    );
  }
  switch (row.status) {
    case "building":
    case "serving": {
      const digest = requireMatchingDigest(row, target);
      if (digest.isErr()) {
        return Result.err(digest.error);
      }
      if (row.status === "serving") {
        return Result.ok({ type: "already_serving", target });
      }
      const serving = rows.find(({ status }) => status === "serving");
      return Result.ok({
        type: "promote",
        target,
        demotes: serving?.generation ?? null,
      });
    }
    case "retiring":
      return Result.err(
        new CorpusGenerationRetiringError({
          message: `${target.family}/${target.generation} is retiring; it must return to building and be reconciled before it can serve`,
          family: target.family,
          generation: target.generation,
        }),
      );
    case "retired":
      return Result.err(
        new CorpusGenerationRetiredError({
          message: `${target.family}/${target.generation} is retired and cannot serve again`,
          family: target.family,
          generation: target.generation,
        }),
      );
    default:
      row.status satisfies never;
      return panic(`Unhandled generation status: ${String(row.status)}`);
  }
};

/** The physical index ids the generation must answer from before it serves. */
const requiredIndexIds = (manifest: CorpusIndexManifest): string[] => {
  // The generation-wide pattern is what an unscoped search reads; a pattern
  // matching no index, or only empty ones, is the empty served set.
  const pattern = corpusIndexPattern(manifest.generation);
  switch (manifest.route.type) {
    case "case_law_group":
      // The groups the generation was created with. A group declared later is
      // enrolled and gated on its own, so it does not hold back the flip.
      return [
        pattern,
        ...new Set(
          Object.keys(manifest.route.byJurisdiction).map((jurisdiction) =>
            corpusIndexIdFromManifest(manifest, jurisdiction),
          ),
        ),
      ];
    case "jurisdiction":
      // An open jurisdiction set: the code cannot name each index, only the
      // generation as a whole.
      return [pattern];
    default:
      manifest.route satisfies never;
      return panic(`Unhandled route: ${String(manifest.route)}`);
  }
};

type IndexEvidence = { indexId: string; documents: number };

/** The status the engine answers a search of an index that does not exist with. */
const HTTP_NOT_FOUND = 404;

type CorpusIndexSearcher = Pick<CorpusIndexClient, "search">;

/**
 * Count each required index's documents (opening passages, one per
 * document) on the search endpoint. Sequential: a handful of count-only
 * requests, and the first refusal is the one an operator acts on.
 */
const checkServedIndexes = async (
  target: DeclaredTarget,
  client: CorpusIndexSearcher,
): Promise<Result<IndexEvidence[], IndexRefusal>> => {
  const { openingPassageQuery } = corpusIndexReadContract(
    target.family,
    target.generation,
  );
  const evidence: IndexEvidence[] = [];
  for (const indexId of requiredIndexIds(target.manifest)) {
    const counted = await client.search({
      observer: "unobserved",
      indexId,
      query: openingPassageQuery,
      maxHits: 0,
    });
    if (counted.isErr()) {
      return Result.err(
        counted.error.status === HTTP_NOT_FOUND
          ? new CorpusGenerationIndexMissingError({
              message: `Index ${indexId} does not exist on the search endpoint`,
              indexId,
            })
          : new CorpusGenerationIndexUnreadableError({
              message: `Index ${indexId} could not be counted: ${counted.error.message}`,
              indexId,
              cause: counted.error,
            }),
      );
    }
    if (counted.value.numHits === 0) {
      return Result.err(
        new CorpusGenerationIndexEmptyError({
          message: `Index ${indexId} holds no documents on the search endpoint`,
          indexId,
        }),
      );
    }
    evidence.push({ indexId, documents: counted.value.numHits });
  }
  return Result.ok(evidence);
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

type CommandContext = {
  withDatabase: WithCorpusDatabase;
  indexClient: (manifest: CorpusIndexManifest) => CorpusIndexSearcher;
  searchEndpoint: (manifest: CorpusIndexManifest) => string | null;
  write: (line: string) => void;
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

const planRegisterTx = async (
  tx: Transaction,
  target: DeclaredTarget,
  lock: RowLock,
) => planRegister(await readFamilyRowsTx(tx, target.family, lock), target);

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
      await rootDb.transaction(
        async (tx) => await planRegisterTx(tx, target, "none"),
      ),
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
        const locked = await planRegisterTx(tx, target, "update");
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

const planServeTx = async (
  tx: Transaction,
  target: DeclaredTarget,
  lock: RowLock,
) => planServe(await readFamilyRowsTx(tx, target.family, lock), target);

const transitionLine = (
  plan: Extract<ServePlan, { type: "promote" }>,
): string =>
  plan.demotes === null
    ? `plan: ${plan.target.generation} building -> serving (first serving generation of ${plan.target.family})`
    : `plan: ${plan.target.generation} building -> serving; ${plan.demotes} serving -> retiring`;

const runServe = async (
  context: CommandContext,
  { target, mode }: Extract<CorpusGenerationCommand, { type: "serve" }>,
): Promise<Result<void, CorpusGenerationRefusal>> => {
  const { withDatabase, write } = context;
  write(`serve ${target.family}/${target.generation} (${mode})`);
  write(declaredLine(target));
  const planned = await withDatabase(
    ACCESS.read,
    async (rootDb) =>
      await rootDb.transaction(
        async (tx) => await planServeTx(tx, target, "none"),
      ),
  );
  if (planned.isErr()) {
    return Result.err(planned.error);
  }
  if (planned.value.isErr()) {
    return Result.err(planned.value.error);
  }
  const plan = planned.value.value;
  switch (plan.type) {
    case "already_serving":
      write(
        "checked: already serving with the declared manifest; nothing to do",
      );
      return Result.ok();
    case "promote":
      write("checked: registered as building with the declared manifest");
      break;
    default:
      plan satisfies never;
      return panic(`Unhandled serve plan: ${String(plan)}`);
  }

  const endpoint = context.searchEndpoint(target.manifest);
  if (endpoint === null) {
    return Result.err(
      new CorpusGenerationSearchEndpointMissingError({
        message: `No search endpoint is configured for cluster ${target.manifest.cluster}; the indexes cannot be checked`,
      }),
    );
  }
  // Outside any transaction: network reads never hold registry locks.
  const evidence = await checkServedIndexes(
    target,
    context.indexClient(target.manifest),
  );
  if (evidence.isErr()) {
    return Result.err(evidence.error);
  }
  for (const { indexId, documents } of evidence.value) {
    write(
      `checked: ${indexId} holds ${String(documents)} documents on ${endpoint}`,
    );
  }
  write(transitionLine(plan));
  if (mode === MODES.dryRun) {
    write(modeLine(mode, ""));
    return Result.ok();
  }

  const applied = await withDatabase(
    ACCESS.write,
    async (rootDb) =>
      await rootDb.transaction(async (tx) => {
        // The registry may have moved since the report: decide again under the
        // row locks, and apply what this decision says.
        const locked = await planServeTx(tx, target, "update");
        if (locked.isErr() || locked.value.type === "already_serving") {
          return locked;
        }
        await setServingCorpusIndexGenerationTx(tx, target);
        await recordSystemAudit(tx, "system:corpus-generation-operator", {
          subject: createSafeId<"systemScriptRun">(),
          counts: {
            registered: 0,
            promoted: 1,
            demoted: locked.value.demotes === null ? 0 : 1,
          },
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
  const done = applied.value.value;
  switch (done.type) {
    case "already_serving":
      write(
        `Applied: nothing to do; ${target.family}/${target.generation} was made serving meanwhile.`,
      );
      return Result.ok();
    case "promote":
      write(
        modeLine(
          mode,
          `Applied: ${target.family}/${target.generation} serves${done.demotes === null ? "" : `; ${done.demotes} is retiring`}.`,
        ),
      );
      return Result.ok();
    default:
      done satisfies never;
      return panic(`Unhandled serve plan: ${String(done)}`);
  }
};

type RunCorpusGenerationOptions = {
  args: readonly string[];
  withDatabase?: WithCorpusDatabase;
  indexClient?: (manifest: CorpusIndexManifest) => CorpusIndexSearcher;
  searchEndpoint?: (manifest: CorpusIndexManifest) => string | null;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
};

/** Run one command; resolves with the process exit code. */
export const runCorpusGenerationCommand = async ({
  args,
  withDatabase = withOperatorDatabase,
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
    indexClient,
    searchEndpoint,
    write,
  };
  const outcome = await (async () => {
    switch (command.value.type) {
      case "status":
        return await runStatus(context);
      case "register":
        return await runRegister(context, command.value);
      case "serve":
        return await runServe(context, command.value);
      default:
        command.value satisfies never;
        return panic(`Unhandled command: ${String(command.value)}`);
    }
  })();
  if (outcome.isErr()) {
    writeError(`refused (${outcome.error._tag}): ${outcome.error.message}`);
    return 1;
  }
  return 0;
};

if (import.meta.main) {
  // The door's connections stay open otherwise.
  process.exit(
    await runCorpusGenerationCommand({ args: process.argv.slice(2) }),
  );
}

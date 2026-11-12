/**
 * The one owner of an organization's caps on model runs: how many runs of a
 * kind may be queued or running at once, and how many may start per
 * Europe/Prague day.
 *
 * The counters live in `model_run_budgets`, one row per organization and
 * kind. A run table's insert trigger charges its row and refuses a start past
 * either cap; status triggers free the active slot when the run ends. A start
 * therefore goes through `startModelRun`, which hands the trigger the
 * configured limits and turns its refusal into a typed error, and a worker
 * re-checks the counter through `checkModelRunCaps` before each model call.
 */

import { panic, Result, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { MODEL_RUN_CAP_CODES } from "@stll/api-contract/model-run-caps";
import { declareFingerprintFields } from "@stll/errors";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { modelRunBudgets } from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { MODEL_RUN_CAP_ENV } from "@/api/lib/usage/model-run-caps/config";
import type {
  ModelRunCaps,
  ModelRunKind,
} from "@/api/lib/usage/model-run-caps/config";

type CapReason = keyof typeof MODEL_RUN_CAP_CODES;

/** What the organization reached, per kind. */
const CAP_MESSAGES = {
  "list-run": {
    active:
      "This organization has reached its limit of list AI runs in progress (verifications and fact extractions).",
    daily:
      "This organization has reached its daily limit of list AI runs (verifications and fact extractions).",
  },
  "document-review": {
    active:
      "This organization has reached its limit of document reviews in progress.",
    daily: "This organization has reached its daily limit of document reviews.",
  },
} as const satisfies Record<ModelRunKind, Record<CapReason, string>>;

/** The run whose end frees an active slot, per kind. */
const RUN_IN_PROGRESS = {
  "list-run": "a verification or fact extraction",
  "document-review": "a document review",
} as const satisfies Record<ModelRunKind, string>;

/** Which database refusal is which cap. The insert trigger raises these. */
const CAP_CONSTRAINTS = {
  active: "model_run_active_cap",
  daily: "model_run_daily_cap",
} as const satisfies Record<CapReason, string>;

export class ModelRunCapError extends TaggedError("ModelRunCapError")<{
  message: string;
  kind: ModelRunKind;
  reason: CapReason;
  hint: string;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }

  get code() {
    return MODEL_RUN_CAP_CODES[this.reason];
  }
}

type CapRefusalArgs = {
  kind: ModelRunKind;
  reason: CapReason;
  /** The call to retry, e.g. `lists.verifications.create`. */
  operation: string;
};

const capError = ({ kind, reason, operation }: CapRefusalArgs) =>
  new ModelRunCapError({
    kind,
    reason,
    message: CAP_MESSAGES[kind][reason],
    hint:
      reason === "active"
        ? `Wait for ${RUN_IN_PROGRESS[kind]} in progress to finish, then retry ${operation}.`
        : `Retry ${operation} after midnight in Europe/Prague.`,
  });

/** The refusal every surface answers with: 429, the shared code, and a
 *  hint that names what to wait for. */
export const modelRunCapRefusal = (error: ModelRunCapError) =>
  new HandlerError({
    status: 429,
    code: error.code,
    message: error.message,
    hint: error.hint,
    retryable: true,
  });

const getModelRunCaps = (kind: ModelRunKind): ModelRunCaps => ({
  active: env[MODEL_RUN_CAP_ENV[kind].active],
  startsPerDay: env[MODEL_RUN_CAP_ENV[kind].startsPerDay],
});

/** The transaction settings the insert trigger reads a kind's limits from. */
const limitSettings = (kind: ModelRunKind) => {
  const suffix = kind.replaceAll("-", "_");
  return {
    active: `app.model_run_active_limit_${suffix}`,
    daily: `app.model_run_daily_limit_${suffix}`,
  };
};

type StartModelRunArgs<T> = {
  safeDb: SafeDb;
  kind: ModelRunKind;
  operation: string;
  caps?: ModelRunCaps;
  /**
   * Insert the run row of this kind, and anything that must commit with it.
   * The insert trigger charges the organization's counter after the row and
   * refuses a run past either cap; a refusal or any throw rolls back the run
   * and the charge together.
   */
  start: (tx: Transaction) => Promise<T>;
};

/** Start one run of a kind under its organization's caps. */
export const startModelRun = async <T>({
  safeDb,
  kind,
  operation,
  caps = getModelRunCaps(kind),
  start,
}: StartModelRunArgs<T>): Promise<
  Result<T, ModelRunCapError | SafeDbError>
> => {
  const settings = limitSettings(kind);
  const started = await safeDb(async (tx) => {
    await tx.execute(sql`SELECT
      set_config(${settings.active}, ${String(caps.active)}, true),
      set_config(${settings.daily}, ${String(caps.startsPerDay)}, true)`);
    return await start(tx);
  });
  return started.mapError((cause) => {
    for (const reason of ["active", "daily"] as const) {
      if (
        isPgConstraintError(
          cause,
          PG_ERROR.CHECK_VIOLATION,
          CAP_CONSTRAINTS[reason],
        )
      ) {
        return capError({ kind, reason, operation });
      }
    }
    return cause;
  });
};

type ReadModelRunBudgetArgs = {
  tx: Pick<Transaction, "select">;
  kind: ModelRunKind;
  organizationId: SafeId<"organization">;
};

/** Counters are organization-scoped even when the caller sees one matter. */
const readModelRunBudget = async ({
  tx,
  kind,
  organizationId,
}: ReadModelRunBudgetArgs) => {
  const budget = (
    await tx
      .select({
        active: modelRunBudgets.activeRuns,
        activeLimit: modelRunBudgets.activeLimit,
        dailyLimit: modelRunBudgets.dailyLimit,
        starts: sql<number>`CASE WHEN ${modelRunBudgets.startsDay} = stella_model_run_day(clock_timestamp())
      THEN ${modelRunBudgets.startsToday} ELSE 0 END`,
      })
      .from(modelRunBudgets)
      .where(
        and(
          eq(modelRunBudgets.organizationId, organizationId),
          eq(modelRunBudgets.runKind, kind),
        ),
      )
      .limit(1)
  ).at(0);
  if (budget === undefined) {
    panic("A started model run has no organization counter");
  }
  return budget;
};

type DecideModelRunCapsArgs = {
  kind: ModelRunKind;
  operation: string;
  active: number;
  starts: number;
  caps: ModelRunCaps;
  /** `start` admits new work only below the caps; `dispatch` admits the
   *  model calls of a run already counted in them. */
  phase: "start" | "dispatch";
};

export const decideModelRunCaps = ({
  kind,
  operation,
  active,
  starts,
  caps,
  phase,
}: DecideModelRunCapsArgs): Result<void, ModelRunCapError> => {
  const allowance = phase === "dispatch" ? 1 : 0;
  if (active >= caps.active + allowance) {
    return Result.err(capError({ kind, reason: "active", operation }));
  }
  if (starts >= caps.startsPerDay + allowance) {
    return Result.err(capError({ kind, reason: "daily", operation }));
  }
  return Result.ok();
};

type CheckModelRunCapsArgs = ReadModelRunBudgetArgs & {
  operation: string;
  /**
   * `dispatch`: a model call of a run already counted in the caps.
   * `start`: model work that is no run of its own (a re-check of one claim):
   * it takes no slot and no start, but is refused once the organization is
   * at either cap, so it cannot spend past a budget its runs have used up.
   */
  phase: "start" | "dispatch";
  caps?: ModelRunCaps;
};

/**
 * Check the organization's counter before a model call. The lower of the
 * configured caps and the limits the counter recorded at its last start
 * applies, so lowering a cap stops work already running.
 */
export const checkModelRunCaps = async ({
  tx,
  kind,
  organizationId,
  operation,
  phase,
  caps = getModelRunCaps(kind),
}: CheckModelRunCapsArgs): Promise<Result<void, ModelRunCapError>> => {
  const budget = await readModelRunBudget({ tx, kind, organizationId });
  return decideModelRunCaps({
    kind,
    operation,
    active: budget.active,
    starts: budget.starts,
    caps: {
      active: Math.min(caps.active, budget.activeLimit),
      startsPerDay: Math.min(caps.startsPerDay, budget.dailyLimit),
    },
    phase,
  });
};

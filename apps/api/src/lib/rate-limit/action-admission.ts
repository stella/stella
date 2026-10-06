import { panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import {
  createAdmissionRedis,
  resolveAdmissionRedisClient,
  sendAdmissionRedisCommand,
  type AdmissionRedisClient,
  type AdmissionRedisReady,
} from "@/api/lib/admission-redis";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  ActionAdmissionError,
  actionAdmissionRefusal as configuredActionAdmissionRefusal,
} from "@/api/lib/errors/action-admission-error";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { ACTION_KINDS } from "@/api/lib/rate-limit/action-kinds";
import type {
  AdmittedActionIdentity,
  ConcurrencyOnlyActionKind,
} from "@/api/lib/rate-limit/action-kinds";
import {
  ACTION_PERIOD_ACQUIRE_SCRIPT,
  ACTION_SERVICE_DEADLINE_EXPIRED,
  ACTION_SERVICE_DEADLINE_SCRIPT,
  actionPeriodArguments,
  staleActionPeriodTime,
  PER_KIND_PERIOD_SCOPE,
  resolveActionPeriodBudget,
  type ActionPeriodBudget,
  type ActionPeriodBudgetError,
  type ActionPeriodPolicy,
  type ActionPeriodScope,
} from "@/api/lib/rate-limit/action-period-budget";
import {
  configuredDemoActionBudget,
  withDemoActionBudget,
  type DemoActionBudget,
} from "@/api/lib/rate-limit/demo-action-budget";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";
import {
  runObservedAction,
  type ActionCostRecorder,
} from "@/api/lib/usage/action-costs/context";
import {
  getActionCostRecorder,
  reportMissingActionCostIdentity,
} from "@/api/lib/usage/action-costs/recorder";
import { resolveOrganizationAccess } from "@/api/lib/usage/organization-access";
import {
  actionDrawsServiceBudget,
  readOrganizationActionState,
  resolveOrganizationActionBudget,
  type OrganizationActionBudgetConfig,
} from "@/api/lib/usage/organization-action-budget";

type RedisCommands = AdmissionRedisClient;

const REDIS_COMMAND_TIMEOUT_MS = 500;
const RENEW_FAILURE = failureSink({
  event: "action_admission.renew_failed",
  expected: [],
});
const RELEASE_FAILURE = failureSink({
  event: "action_admission.release_failed",
  expected: [],
});
const admissionRedis = createAdmissionRedis();

export const closeActionAdmissionRedis = () => admissionRedis.close();
export const startActionAdmissionRedis = async () => {
  const connection = await admissionRedis.ready();
  if (Result.isError(connection)) {
    await Promise.reject(connection.error);
  }
};

export { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";

export const actionAdmissionRefusal = (error: ActionAdmissionError) =>
  configuredActionAdmissionRefusal(error, env.ACTION_LIMIT_CONTACT_URL);

type ActionAdmissionPolicy = {
  organizationConcurrency: number;
  userConcurrency: number;
  leaseMs: number;
};

// Both keys share the organization hash slot. The operation admits to both
// pools atomically, then expires even if the process dies before release.
// Redis supplies time so clocks on separate API hosts cannot expire one
// another's live leases.
const ACQUIRE_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
${ACTION_SERVICE_DEADLINE_SCRIPT}
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) or redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[3]) then
  return 0
end
${ACTION_PERIOD_ACQUIRE_SCRIPT}
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[1]), ARGV[4])
redis.call("ZADD", KEYS[2], now + tonumber(ARGV[1]), ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[1])
redis.call("PEXPIRE", KEYS[2], ARGV[1])
return 1
`;

const RENEW_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local orgExpiry = redis.call("ZSCORE", KEYS[1], ARGV[1])
local userExpiry = redis.call("ZSCORE", KEYS[2], ARGV[1])
if orgExpiry == false or userExpiry == false or tonumber(orgExpiry) <= now or tonumber(userExpiry) <= now then
  return 0
end
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call("ZADD", KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
redis.call("PEXPIRE", KEYS[2], ARGV[2])
return 1
`;

const RESERVE_PERIOD_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
${ACTION_SERVICE_DEADLINE_SCRIPT}
local orgExpiry = redis.call("ZSCORE", KEYS[1], ARGV[4])
local userExpiry = redis.call("ZSCORE", KEYS[2], ARGV[4])
if orgExpiry == false or userExpiry == false or tonumber(orgExpiry) <= now or tonumber(userExpiry) <= now then
  return -2
end
${ACTION_PERIOD_ACQUIRE_SCRIPT}
return 1
`;

const RELEASE_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
return 1
`;

type AdmissionKeys = {
  organization: CoordinationKey;
  user: CoordinationKey;
};

const admissionKeys = ({
  organizationId,
  userId,
  pool,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  pool: "interactive" | "background";
}): AdmissionKeys => ({
  organization: coordinationKey({
    scope: "action-admission",
    slot: organizationId,
    suffix: pool === "background" ? "background:organization" : "organization",
  }),
  user: coordinationKey({
    scope: "action-admission",
    slot: organizationId,
    suffix:
      pool === "background" ? `background:user:${userId}` : `user:${userId}`,
  }),
});

const configuredPolicy = (
  pool: "interactive" | "background",
): Result<ActionAdmissionPolicy, ActionAdmissionError> => {
  const organizationConcurrency =
    pool === "background"
      ? env.ACTION_ADMISSION_BACKGROUND_ORG_CONCURRENCY
      : env.ACTION_ADMISSION_ORG_CONCURRENCY;
  const userConcurrency =
    pool === "background"
      ? env.ACTION_ADMISSION_BACKGROUND_USER_CONCURRENCY
      : env.ACTION_ADMISSION_USER_CONCURRENCY;
  const leaseMs = env.ACTION_ADMISSION_LEASE_MS;
  if (
    organizationConcurrency === undefined ||
    userConcurrency === undefined ||
    leaseMs === undefined
  ) {
    return Result.err(
      new ActionAdmissionError({
        message: "Action admission configuration is incomplete",
        reason: "unavailable",
      }),
    );
  }
  return Result.ok({ organizationConcurrency, userConcurrency, leaseMs });
};

type OrganizationStateReader = (scope: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) => ReturnType<typeof readOrganizationActionState>;

type ActionAdmissionOptions<T = unknown> = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  run: (signal: AbortSignal, control: ActionAdmissionControl) => Promise<T>;
  enabled?: boolean;
  scope?: "inherit" | "independent";
  policy?: ActionAdmissionPolicy;
  periodReservation?: "on-acceptance" | undefined;
  periodPolicy?: ActionPeriodPolicy | undefined;
  serviceBudgetsEnabled?: boolean;
  serviceBudgetConfig?: OrganizationActionBudgetConfig;
  organizationStateDb?: ScopedDb;
  readOrganizationState?: OrganizationStateReader;
  budgetNow?: () => number;
  redis?: RedisCommands | undefined;
  redisReady?: AdmissionRedisReady;
  createId?: () => string;
  timing?: AdmissionTiming;
  costRecorder?: ActionCostRecorder | null;
  demoActionBudget?: DemoActionBudget;
} & ActionAdmissionReservation &
  (
    | {
        execution: "background-job";
        actionKind: ConcurrencyOnlyActionKind;
        periodIdentity?: never;
      }
    | { execution?: "queued-kickoff" | undefined; actionKind?: never }
  );

type ActionAdmissionControl = {
  reservePeriod: (
    identity: AdmittedActionIdentity,
    organizationStateDb?: ScopedDb,
  ) => Promise<Result<void, ActionAdmissionError>>;
};

const disabledControl: ActionAdmissionControl = {
  reservePeriod: async () => await Promise.resolve(Result.ok(undefined)),
};

type ActionAdmissionReservation =
  | {
      mode?: "action";
      periodIdentity?: AdmittedActionIdentity;
    }
  | {
      mode: "concurrency-only";
      periodIdentity?: never;
    };

type AdmissionTiming = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
};

type AdmissionScope = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  signal: AbortSignal;
  control: ActionAdmissionControl;
  status: "active" | "settled";
  keys: AdmissionKeys;
  limits: ActionAdmissionPolicy;
  leaseId: string;
  organizationBudgetOptions: ResolveAdmissionBudgetOptions;
  queuedIdentity: AdmittedActionIdentity | undefined;
};

const admissionScope = new AsyncLocalStorage<AdmissionScope>();

const defaultTiming: AdmissionTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

type AdmissionExecutorOptions = {
  keys: AdmissionKeys;
  budget: ActionPeriodBudget | null;
  serviceDeadlineMs: number | null;
  organizationId: SafeId<"organization">;
  periodIdentity: AdmittedActionIdentity | undefined;
  redis: RedisCommands | undefined;
  redisReady: AdmissionRedisReady;
};

const createAdmissionExecutor = ({
  keys,
  budget,
  serviceDeadlineMs,
  organizationId,
  periodIdentity,
  redis,
  redisReady,
}: AdmissionExecutorOptions) => {
  const retryIdentity =
    periodIdentity === undefined
      ? undefined
      : {
          actionKind: periodIdentity.actionKind,
          logicalPhaseId: periodIdentity.logicalPhaseId,
        };
  const execute = async (script: string, args: string[]) => {
    const outcome = await Result.tryPromise({
      try: async () => {
        const connected =
          redis === undefined
            ? await withCommandTimeout({
                command: resolveAdmissionRedisClient(redisReady),
                commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
                label: "action-admission-redis-connect",
              })
            : Result.ok(redis);
        if (Result.isError(connected)) {
          return Result.err(
            new ActionAdmissionError({
              message: "Action admission is unavailable",
              reason: "unavailable",
              cause: connected.error,
            }),
          );
        }
        const client = connected.value;
        const send = async (
          window: ActionPeriodBudget | null,
          commandArgs: string[],
        ) => {
          // Renewal and release touch concurrency keys alone.
          const scriptKeys =
            (script === ACQUIRE_SCRIPT || script === RESERVE_PERIOD_SCRIPT) &&
            window !== null
              ? [keys.organization, keys.user, window.key]
              : [keys.organization, keys.user];
          return await withCommandTimeout({
            command: sendAdmissionRedisCommand(client, [
              script,
              String(scriptKeys.length),
              ...scriptKeys,
              ...commandArgs,
              ...((script === ACQUIRE_SCRIPT ||
                script === RESERVE_PERIOD_SCRIPT) &&
              serviceDeadlineMs !== null
                ? [String(serviceDeadlineMs)]
                : []),
            ]),
            commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
            label: "action-admission-redis-command",
          });
        };
        const commandResult = await send(budget, args);
        if (Result.isError(commandResult)) {
          return Result.err(
            ActionAdmissionError.is(commandResult.error)
              ? commandResult.error
              : new ActionAdmissionError({
                  message: "Action admission is unavailable",
                  reason: "unavailable",
                  cause: commandResult.error,
                }),
          );
        }
        const reply = commandResult.value;
        const storeNow =
          script === ACQUIRE_SCRIPT || script === RESERVE_PERIOD_SCRIPT
            ? staleActionPeriodTime(reply)
            : null;
        if (budget === null || storeNow === null) {
          return Result.ok(reply);
        }

        // A stale window has not reserved anything. Retry once using store time,
        // with the original lease and logical phase, never after another failure.
        const refreshed = resolveActionPeriodBudget({
          organizationId,
          identity: retryIdentity,
          policy: {
            periodMs: budget.endMs - budget.startMs,
            limit: budget.limit,
          },
          scope: budget.scope,
          nowMs: storeNow,
        });
        if (Result.isError(refreshed)) {
          return Result.err(
            new ActionAdmissionError({
              message: "Action admission is unavailable",
              reason: "unavailable",
              cause: refreshed.error,
            }),
          );
        }
        if (refreshed.value === null) {
          return Result.ok(-2);
        }
        const retried = await send(refreshed.value, [
          ...args.slice(0, 4),
          ...actionPeriodArguments(refreshed.value),
        ]);
        return retried.mapError((cause) =>
          ActionAdmissionError.is(cause)
            ? cause
            : new ActionAdmissionError({
                message: "Action admission is unavailable",
                reason: "unavailable",
                cause,
              }),
        );
      },
      catch: (error: unknown) =>
        ActionAdmissionError.is(error)
          ? error
          : new ActionAdmissionError({
              message: "Action admission is unavailable",
              reason: "unavailable",
              cause: error,
            }),
    });

    return Result.isError(outcome) ? outcome : outcome.value;
  };

  return execute;
};

type ObservedAdmissionRunOptions<T> = Pick<
  ActionAdmissionOptions,
  "organizationId" | "userId"
> & {
  periodIdentity: AdmittedActionIdentity | undefined;
  costRecorder: ActionAdmissionOptions["costRecorder"];
  run: (signal: AbortSignal, control: ActionAdmissionControl) => Promise<T>;
};

const createObservedAdmissionRun = <T>({
  organizationId,
  userId,
  periodIdentity,
  costRecorder,
  run,
}: ObservedAdmissionRunOptions<T>) => {
  const recorder =
    costRecorder === null
      ? undefined
      : (costRecorder ?? getActionCostRecorder());
  return async (
    signal: AbortSignal,
    control: ActionAdmissionControl,
  ): Promise<T> => {
    const executeRun = async () => {
      signal.throwIfAborted();
      return await run(signal, control);
    };
    if (recorder === undefined) {
      return await executeRun();
    }
    if (periodIdentity === undefined) {
      reportMissingActionCostIdentity();
      return await executeRun();
    }
    return await runObservedAction({
      identity: { organizationId, ...periodIdentity },
      userId,
      recorder,
      run: executeRun,
    });
  };
};

/**
 * The disabled branch never opens Valkey or reads admission configuration.
 * Nested admission must be awaited: same-caller work shares the parent's lease
 * and signal only until that parent settles. Detached execution needs a fresh scope.
 */
type ResolveAdmissionBudgetOptions = Pick<
  ActionAdmissionOptions,
  "organizationId" | "userId"
> & {
  serviceBudgetsEnabled: boolean;
  serviceBudgetConfig: OrganizationActionBudgetConfig;
  periodIdentity: AdmittedActionIdentity | undefined;
  periodPolicy: ActionPeriodPolicy | undefined;
  organizationStateDb: ScopedDb | undefined;
  readOrganizationState: OrganizationStateReader | undefined;
  budgetNow: () => number;
};

/**
 * The period count an admitted action draws. `uncounted`: the action draws no
 * count by design (a kind that consumes no services, or free-floor work on the
 * organization's own key). `unconfigured`: the deployment sets no period limit.
 */
type AdmissionPeriod =
  | {
      type: "counted";
      budget: ActionPeriodBudget;
      serviceDeadlineMs: number | null;
    }
  | { type: "uncounted" }
  | { type: "unconfigured" };

type CountedAdmissionPeriod = Extract<AdmissionPeriod, { type: "counted" }>;

const admittedPeriodBudget = (period: AdmissionPeriod) => {
  switch (period.type) {
    case "counted":
      return {
        budget: period.budget,
        serviceDeadlineMs: period.serviceDeadlineMs,
      };
    case "uncounted":
    case "unconfigured":
      return { budget: null, serviceDeadlineMs: null };
    default:
      period satisfies never;
      return panic("Unhandled admission period");
  }
};

const periodBudgetRefusal = (error: ActionPeriodBudgetError) =>
  new ActionAdmissionError({
    message: error.message,
    reason: "unavailable",
    cause: error,
  });

const resolveAdmissionBudget = async ({
  organizationId,
  userId,
  periodIdentity,
  periodPolicy,
  serviceBudgetsEnabled,
  serviceBudgetConfig,
  readOrganizationState,
  organizationStateDb,
  budgetNow,
}: ResolveAdmissionBudgetOptions): Promise<
  Result<AdmissionPeriod, ActionAdmissionError>
> => {
  let serviceDeadlineMs: number | null = null;
  let nowMs = budgetNow();
  let resolvedPeriodPolicy = periodPolicy;
  let periodScope: ActionPeriodScope = PER_KIND_PERIOD_SCOPE;
  let consumesServices = true;
  if (serviceBudgetsEnabled) {
    if (periodIdentity === undefined) {
      return Result.err(
        new ActionAdmissionError({
          message: "Action service identity is missing",
          reason: "unavailable",
        }),
      );
    }
    consumesServices = ACTION_KINDS[periodIdentity.actionKind].consumesServices;
    if (consumesServices) {
      const readState =
        readOrganizationState ??
        (organizationStateDb === undefined
          ? undefined
          : async () =>
              await readOrganizationActionState(
                organizationStateDb,
                organizationId,
              ));
      if (readState === undefined) {
        return Result.err(
          new ActionAdmissionError({
            message: "Organization action scope is missing",
            reason: "unavailable",
          }),
        );
      }
      const state = await Result.tryPromise({
        try: async () => await readState({ organizationId, userId }),
        catch: (cause: unknown) =>
          new ActionAdmissionError({
            message: "Organization action access could not be read",
            reason: "unavailable",
            cause,
          }),
      });
      if (Result.isError(state)) {
        return state;
      }
      nowMs = budgetNow();
      const access = resolveOrganizationAccess({
        snapshot: state.value.snapshot,
        now: new Date(nowMs),
        freeTier: state.value.freeTier,
      });
      consumesServices = actionDrawsServiceBudget({
        access,
        serviceCredentials:
          ACTION_KINDS[periodIdentity.actionKind].serviceCredentials,
        modelCredentials: state.value.modelCredentials,
      });
      const organizationBudget = consumesServices
        ? resolveOrganizationActionBudget({ access, ...serviceBudgetConfig })
        : ({ status: "uncounted" } as const);
      switch (organizationBudget.status) {
        case "uncounted":
          break;
        case "not_enabled":
          return Result.err(
            new ActionAdmissionError({
              message: "Organization service actions are not enabled",
              reason: "not_enabled",
            }),
          );
        case "unavailable":
          return Result.err(
            new ActionAdmissionError({
              message: "Organization action configuration is incomplete",
              reason: "unavailable",
            }),
          );
        case "resolved":
          resolvedPeriodPolicy = organizationBudget.policy;
          periodScope = organizationBudget.scope;
          serviceDeadlineMs = organizationBudget.serviceDeadlineMs;
          break;
        default:
          organizationBudget satisfies never;
          return panic("Unhandled organization action budget");
      }
    }
  }
  if (!consumesServices) {
    return Result.ok({ type: "uncounted" });
  }
  const resolvedBudget = resolveActionPeriodBudget({
    organizationId,
    identity: periodIdentity,
    policy: resolvedPeriodPolicy,
    scope: periodScope,
    nowMs,
  });
  if (Result.isError(resolvedBudget)) {
    return Result.err(periodBudgetRefusal(resolvedBudget.error));
  }
  const budget = resolvedBudget.value;
  return Result.ok(
    budget === null
      ? { type: "unconfigured" }
      : { type: "counted", budget, serviceDeadlineMs },
  );
};

// A queued kickoff relinquishes its slot after enqueue; its period cap bounds
// backlog. Work that draws no service count still takes the per-kind cap.
const resolveQueuedBudget = async (
  options: ResolveAdmissionBudgetOptions,
): Promise<Result<CountedAdmissionPeriod, ActionAdmissionError>> => {
  const resolved = await resolveAdmissionBudget(options);
  if (Result.isError(resolved)) {
    return Result.err(resolved.error);
  }
  const period = resolved.value;
  switch (period.type) {
    case "counted":
      return Result.ok(period);
    case "uncounted": {
      const backlog = resolveActionPeriodBudget({
        organizationId: options.organizationId,
        identity: options.periodIdentity,
        policy: options.periodPolicy,
        scope: PER_KIND_PERIOD_SCOPE,
        nowMs: options.budgetNow(),
      });
      if (Result.isError(backlog)) {
        return Result.err(periodBudgetRefusal(backlog.error));
      }
      if (backlog.value !== null) {
        return Result.ok({
          type: "counted",
          budget: backlog.value,
          serviceDeadlineMs: null,
        });
      }
      break;
    }
    case "unconfigured":
      break;
    default:
      period satisfies never;
      return panic("Unhandled admission period");
  }
  return Result.err(
    new ActionAdmissionError({
      message: "Queued action admission requires a configured period budget",
      reason: "unavailable",
    }),
  );
};

const configuredServiceBudgets = () => ({
  periodMs: env.ACTION_ADMISSION_PERIOD_MS,
  evaluationActions: env.SERVICE_ACTIONS_EVALUATION_PERIOD_ACTIONS,
  selfManagedActions: env.SERVICE_ACTIONS_SELF_MANAGED_ACTIONS,
});

const acquisitionRefusal = (reply: unknown): ActionAdmissionError | null => {
  if (reply === ACTION_SERVICE_DEADLINE_EXPIRED) {
    return new ActionAdmissionError({
      message: "Organization service actions are not enabled",
      reason: "not_enabled",
    });
  }
  if (reply === 0 || reply === -1) {
    return new ActionAdmissionError({
      message:
        reply === -1
          ? "Action period limit reached"
          : "Concurrent action limit reached",
      reason: reply === -1 ? "period_exhausted" : "busy",
    });
  }
  if (reply !== 1) {
    return new ActionAdmissionError({
      message: "Action admission returned an invalid response",
      reason: "unavailable",
    });
  }

  return null;
};

type ReuseAdmissionOptions = Pick<ActionAdmissionOptions, "organizationId"> & {
  periodIdentity: AdmittedActionIdentity | undefined;
  periodPolicy: ActionPeriodPolicy | undefined;
  scope: AdmissionScope;
  serviceBudgetsEnabled: boolean;
  mode: "action" | "concurrency-only";
  budgetNow: () => number;
};

const reuseAdmissionScope = async <T>({
  scope,
  organizationId,
  periodIdentity,
  periodPolicy,
  serviceBudgetsEnabled,
  mode,
  budgetNow,
  run,
}: ReuseAdmissionOptions & {
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<Result<T, unknown>> => {
  if (
    mode === "action" &&
    serviceBudgetsEnabled &&
    !periodIdentity?.logicalPhaseId.trim()
  ) {
    return Result.err(
      new ActionAdmissionError({
        message: "Action service identity is incomplete",
        reason: "unavailable",
      }),
    );
  }
  if (mode === "action" && !serviceBudgetsEnabled) {
    const budget = resolveActionPeriodBudget({
      organizationId,
      identity: periodIdentity,
      policy: periodPolicy,
      scope: PER_KIND_PERIOD_SCOPE,
      nowMs: budgetNow(),
    });
    if (Result.isError(budget)) {
      return Result.err(
        new ActionAdmissionError({
          message: budget.error.message,
          reason: "unavailable",
          cause: budget.error,
        }),
      );
    }
  }
  // Validate the nested boundary without reevaluating access or reserving again.
  return await Result.tryPromise({
    try: async () => {
      scope.signal.throwIfAborted();
      const value = await run(scope.signal);
      return value;
    },
    catch: (error: unknown) => error,
  });
};

type PeriodReservationScopeOptions = AdmissionExecutorOptions & {
  userId: SafeId<"user">;
  signal: AbortSignal;
  limits: ActionAdmissionPolicy;
  leaseId: string;
  organizationBudgetOptions: ResolveAdmissionBudgetOptions;
  queuedIdentity?: AdmittedActionIdentity | undefined;
};

const createPeriodReservationScope = ({
  keys,
  budget,
  organizationId,
  userId,
  periodIdentity,
  redis,
  redisReady,
  signal,
  limits,
  leaseId,
  organizationBudgetOptions,
  queuedIdentity,
}: PeriodReservationScopeOptions): AdmissionScope => {
  const reservePhase = async (
    identity: AdmittedActionIdentity,
    organizationStateDb: ScopedDb | undefined,
  ): Promise<Result<void, ActionAdmissionError>> => {
    if (signal.aborted || executionScope.status !== "active") {
      return Result.err(
        new ActionAdmissionError({
          message: "Action admission is unavailable",
          reason: "unavailable",
          cause: signal.reason,
        }),
      );
    }
    const reservationOptions = {
      ...organizationBudgetOptions,
      periodIdentity: identity,
      organizationStateDb:
        organizationStateDb ?? organizationBudgetOptions.organizationStateDb,
    };
    // A queued kickoff reserves its backlog cap even when it draws no count.
    const resolved =
      queuedIdentity === undefined
        ? await resolveAdmissionBudget(reservationOptions)
        : await resolveQueuedBudget(reservationOptions);
    if (Result.isError(resolved)) {
      return resolved;
    }
    const { budget: reservedBudget, serviceDeadlineMs } = admittedPeriodBudget(
      resolved.value,
    );
    if (reservedBudget === null) {
      return Result.ok(undefined);
    }
    const reserve = createAdmissionExecutor({
      keys,
      budget: reservedBudget,
      serviceDeadlineMs,
      organizationId,
      periodIdentity: identity,
      redis,
      redisReady,
    });
    const reply = await reserve(RESERVE_PERIOD_SCRIPT, [
      String(limits.leaseMs),
      String(limits.organizationConcurrency),
      String(limits.userConcurrency),
      leaseId,
      ...actionPeriodArguments(reservedBudget),
    ]);
    if (Result.isError(reply)) {
      return reply;
    }
    const refusal = acquisitionRefusal(reply.value);
    return refusal === null ? Result.ok(undefined) : Result.err(refusal);
  };
  let reservation:
    | {
        identity: AdmittedActionIdentity;
        result: Promise<Result<void, ActionAdmissionError>>;
      }
    | undefined =
    budget !== null && periodIdentity !== undefined
      ? {
          identity: periodIdentity,
          result: Promise.resolve(Result.ok(undefined)),
        }
      : undefined;
  const control: ActionAdmissionControl = {
    reservePeriod: async (identity, organizationStateDb) => {
      if (reservation !== undefined) {
        if (
          reservation.identity.actionKind !== identity.actionKind ||
          reservation.identity.logicalPhaseId !== identity.logicalPhaseId
        ) {
          panic("An admission cannot reserve two logical phases");
        }
        return await reservation.result;
      }
      const stableIdentity = {
        actionKind: identity.actionKind,
        logicalPhaseId: identity.logicalPhaseId,
      };
      const result = reservePhase(stableIdentity, organizationStateDb);
      reservation = { identity: stableIdentity, result };
      return await result;
    },
  };
  const executionScope: AdmissionScope = {
    organizationId,
    userId,
    signal,
    control,
    status: "active",
    keys,
    limits,
    leaseId,
    organizationBudgetOptions,
    queuedIdentity,
  };
  return executionScope;
};

export const reserveQueuedKickoffPeriod = async () => {
  if (!isDeploymentFeatureEnabled("FEATURE_ACTION_ADMISSION")) {
    return Result.ok(undefined);
  }
  const scope = admissionScope.getStore();
  if (scope?.status !== "active" || scope.queuedIdentity === undefined) {
    return panic(
      "Queued period reservation requires an active queued admission scope",
    );
  }
  return await scope.control.reservePeriod(scope.queuedIdentity);
};

type InheritedQueuedAdmissionOptions<T> = {
  inherited: AdmissionScope;
  organizationBudgetOptions: ResolveAdmissionBudgetOptions;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  periodIdentity: AdmittedActionIdentity | undefined;
  periodReservation: ActionAdmissionOptions["periodReservation"];
  redis: RedisCommands | undefined;
  redisReady: AdmissionRedisReady;
  run: ActionAdmissionOptions<T>["run"];
};

const runInheritedQueuedAdmission = async <T>({
  inherited,
  organizationBudgetOptions,
  organizationId,
  userId,
  periodIdentity,
  periodReservation,
  redis,
  redisReady,
  run,
}: InheritedQueuedAdmissionOptions<T>): Promise<Result<T, unknown>> => {
  const nestedBudgetOptions = {
    ...organizationBudgetOptions,
    organizationStateDb:
      organizationBudgetOptions.organizationStateDb ??
      inherited.organizationBudgetOptions.organizationStateDb,
    readOrganizationState:
      organizationBudgetOptions.readOrganizationState ??
      inherited.organizationBudgetOptions.readOrganizationState,
  };
  const resolved = await resolveQueuedBudget(nestedBudgetOptions);
  if (Result.isError(resolved)) {
    return resolved;
  }
  const nested = createPeriodReservationScope({
    keys: inherited.keys,
    budget: null,
    serviceDeadlineMs: resolved.value.serviceDeadlineMs,
    organizationId,
    userId,
    periodIdentity,
    redis,
    redisReady,
    signal: inherited.signal,
    limits: inherited.limits,
    leaseId: inherited.leaseId,
    organizationBudgetOptions: nestedBudgetOptions,
    queuedIdentity: periodIdentity,
  });
  try {
    return await admissionScope.run(nested, async () => {
      inherited.signal.throwIfAborted();
      if (periodReservation !== "on-acceptance") {
        const reserved = await nested.control.reservePeriod(
          periodIdentity ?? panic("Queued action identity is missing"),
        );
        if (Result.isError(reserved)) {
          return reserved;
        }
      }
      return await Result.tryPromise({
        try: async () => await run(inherited.signal, nested.control),
        catch: (error: unknown) => error,
      });
    });
  } finally {
    nested.status = "settled";
  }
};

type ResolveExecutionBudgetOptions = Pick<
  ActionAdmissionOptions,
  "mode" | "execution"
> & {
  organizationBudgetOptions: ResolveAdmissionBudgetOptions;
};

const resolveExecutionBudget = async ({
  mode,
  execution,
  organizationBudgetOptions,
}: ResolveExecutionBudgetOptions) => {
  if (mode === "concurrency-only" || execution === "background-job") {
    return Result.ok({ budget: null, serviceDeadlineMs: null });
  }
  const resolved =
    execution === "queued-kickoff"
      ? await resolveQueuedBudget(organizationBudgetOptions)
      : await resolveAdmissionBudget(organizationBudgetOptions);
  return resolved.map(admittedPeriodBudget);
};

const settledAdmissionOutcome = <T>(
  outcome: Result<T, unknown>,
  signal: AbortSignal,
) => {
  // A settled success may already have committed or charged. Losing the lease
  // cannot replace it with an infrastructure error that invites duplicate work.
  if (
    Result.isError(outcome) &&
    signal.aborted &&
    (outcome.error === signal.reason ||
      (outcome.error instanceof Error && outcome.error.name === "AbortError"))
  ) {
    return Result.err(signal.reason);
  }
  return outcome;
};

const withEnabledActionAdmission = async <T>({
  organizationId,
  userId,
  run,
  scope = "inherit",
  policy,
  mode = "action",
  periodIdentity,
  periodPolicy,
  organizationBudgetOptions,
  execution,
  periodReservation,
  redis,
  redisReady = admissionRedis.ready,
  createId = () => Bun.randomUUIDv7(),
  timing = defaultTiming,
}: ActionAdmissionOptions<T> & {
  organizationBudgetOptions: ResolveAdmissionBudgetOptions;
}): Promise<Result<T, unknown>> => {
  const inherited = admissionScope.getStore();
  if (
    execution !== "background-job" &&
    scope === "inherit" &&
    inherited?.status === "active" &&
    inherited.organizationId === organizationId &&
    inherited.userId === userId
  ) {
    if (execution === "queued-kickoff") {
      return await runInheritedQueuedAdmission({
        inherited,
        organizationBudgetOptions,
        organizationId,
        userId,
        periodIdentity,
        periodReservation,
        redis,
        redisReady,
        run,
      });
    }
    return await reuseAdmissionScope({
      scope: inherited,
      organizationId,
      periodIdentity,
      periodPolicy,
      serviceBudgetsEnabled: organizationBudgetOptions.serviceBudgetsEnabled,
      mode,
      budgetNow: organizationBudgetOptions.budgetNow,
      run: async (signal) => await run(signal, inherited.control),
    });
  }

  const resolvedBudget = await resolveExecutionBudget({
    mode,
    execution,
    organizationBudgetOptions,
  });
  if (Result.isError(resolvedBudget)) {
    return resolvedBudget;
  }
  const { budget, serviceDeadlineMs } = resolvedBudget.value;

  const pool = execution === "background-job" ? "background" : "interactive";
  const resolvedPolicy =
    policy === undefined ? configuredPolicy(pool) : Result.ok(policy);
  if (Result.isError(resolvedPolicy)) {
    return resolvedPolicy;
  }
  const limits = resolvedPolicy.value;
  const keys = admissionKeys({ organizationId, userId, pool });
  const leaseId = createId();
  const initialBudget = periodReservation === "on-acceptance" ? null : budget;
  const periodArgs = actionPeriodArguments(initialBudget);
  const execute = createAdmissionExecutor({
    keys,
    budget: initialBudget,
    serviceDeadlineMs,
    organizationId,
    periodIdentity,
    redis,
    redisReady,
  });

  const initialAttemptAt = timing.now();
  const admitted = await execute(ACQUIRE_SCRIPT, [
    String(limits.leaseMs),
    String(limits.organizationConcurrency),
    String(limits.userConcurrency),
    leaseId,
    ...periodArgs,
  ]);
  if (Result.isError(admitted)) {
    return admitted;
  }
  const refusal = acquisitionRefusal(admitted.value);
  if (refusal !== null) {
    return Result.err(refusal);
  }

  let leaseDeadline = initialAttemptAt + limits.leaseMs;
  const controller = new AbortController();
  let leaseLost: ActionAdmissionError | null = null;
  let stopped = false;
  let cancelScheduled: () => void = () => undefined;
  let renewal: Promise<void> | null = null;

  const loseLease = () => {
    if (stopped || leaseLost !== null) {
      return;
    }
    leaseLost = new ActionAdmissionError({
      message: "Action lease was lost",
      reason: "unavailable",
    });
    cancelScheduled();
    controller.abort(leaseLost);
  };

  const scheduleRenewal = (delayMs: number) => {
    if (!stopped && leaseLost === null) {
      cancelScheduled = timing.schedule(() => {
        renewal = renew()
          .catch((error: unknown) => {
            observeFailure(error, { sink: RENEW_FAILURE });
            loseLease();
          })
          .finally(() => {
            renewal = null;
          });
      }, delayMs);
    }
  };

  const renew = async () => {
    const attemptAt = timing.now();
    if (attemptAt >= leaseDeadline) {
      loseLease();
      return;
    }
    const result = await execute(RENEW_SCRIPT, [
      leaseId,
      String(limits.leaseMs),
    ]);
    if (Result.isOk(result)) {
      if (result.value !== 1) {
        loseLease();
        return;
      }
      leaseDeadline = attemptAt + limits.leaseMs;
      scheduleRenewal(Math.max(1, Math.floor(limits.leaseMs / 2)));
      return;
    }
    observeFailure(result.error, { sink: RENEW_FAILURE });
    const remaining = leaseDeadline - timing.now();
    if (remaining <= 0) {
      loseLease();
      return;
    }
    scheduleRenewal(
      Math.max(1, Math.min(Math.floor(limits.leaseMs / 4), remaining)),
    );
  };

  if (timing.now() >= leaseDeadline) {
    loseLease();
  } else {
    scheduleRenewal(Math.max(1, Math.floor(limits.leaseMs / 2)));
  }

  let outcome: Result<T, unknown>;
  const executionScope = createPeriodReservationScope({
    keys,
    budget: initialBudget,
    serviceDeadlineMs,
    organizationId,
    userId,
    periodIdentity,
    redis,
    redisReady,
    signal: controller.signal,
    queuedIdentity: execution === "queued-kickoff" ? periodIdentity : undefined,
    limits,
    leaseId,
    organizationBudgetOptions,
  });
  try {
    outcome = await Result.tryPromise({
      try: async () =>
        await admissionScope.run(
          executionScope,
          async () => await run(controller.signal, executionScope.control),
        ),
      catch: (error: unknown) => error,
    });
  } finally {
    executionScope.status = "settled";
    stopped = true;
    cancelScheduled();
    await Promise.resolve(renewal);
    const released = await execute(RELEASE_SCRIPT, [leaseId]);
    if (Result.isError(released)) {
      // The lease expires on its own. A release outage must not make a
      // completed action look retryable and invite duplicate side effects.
      observeFailure(released.error, { sink: RELEASE_FAILURE });
    }
  }
  return settledAdmissionOutcome(outcome, controller.signal);
};

export const withActionAdmission = async <T>(
  options: ActionAdmissionOptions<T>,
): Promise<Result<T, unknown>> => {
  const observedRun = createObservedAdmissionRun({
    organizationId: options.organizationId,
    userId: options.userId,
    periodIdentity: options.periodIdentity,
    costRecorder: options.costRecorder,
    run: options.run,
  });
  // The demo account's daily budget holds whether or not admission is
  // enabled, so it wraps both branches.
  return await withDemoActionBudget({
    budget: options.demoActionBudget ?? configuredDemoActionBudget,
    organizationId: options.organizationId,
    userId: options.userId,
    scope:
      options.execution === "background-job"
        ? "independent"
        : (options.scope ?? "inherit"),
    run: async (markStarted) => {
      const startedRun = async (
        signal: AbortSignal,
        control: ActionAdmissionControl,
      ) => {
        markStarted();
        return await observedRun(signal, control);
      };
      if (
        !(
          options.enabled ??
          isDeploymentFeatureEnabled("FEATURE_ACTION_ADMISSION")
        )
      ) {
        return await Result.tryPromise({
          try: async () =>
            await startedRun(new AbortController().signal, disabledControl),
          catch: (error: unknown) => error,
        });
      }
      return await withEnabledActionAdmission({
        ...options,
        run: startedRun,
        organizationBudgetOptions: {
          organizationId: options.organizationId,
          userId: options.userId,
          periodIdentity: options.periodIdentity,
          periodPolicy: options.periodPolicy,
          serviceBudgetsEnabled:
            options.serviceBudgetsEnabled ??
            isDeploymentFeatureEnabled("FEATURE_ORG_SERVICE_BUDGETS"),
          serviceBudgetConfig:
            options.serviceBudgetConfig ?? configuredServiceBudgets(),
          organizationStateDb: options.organizationStateDb,
          readOrganizationState: options.readOrganizationState,
          budgetNow:
            options.budgetNow ??
            (() => Temporal.Now.instant().epochMilliseconds),
        },
      });
    },
  });
};

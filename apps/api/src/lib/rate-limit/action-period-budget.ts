import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

export type ActionPeriodIdentity = {
  actionKind: string;
  /** Stable logical phase, shared by retries; never a lease or attempt ID. */
  logicalPhaseId: string;
};

export type ActionPeriodPolicy = {
  periodMs: number;
  limit: number;
};

export type ActionPeriodBudget = {
  key: CoordinationKey;
  startMs: number;
  endMs: number;
  limit: number;
  phaseField: string;
};

export class ActionPeriodBudgetError extends TaggedError(
  "ActionPeriodBudgetError",
)<{
  message: string;
}> {}

// Flag-on requires a non-evicting admission store; these TTL keys are an operational throttle.
const periodKey = ({
  organizationId,
  actionKind,
  startMs,
  endMs,
}: {
  organizationId: SafeId<"organization">;
  actionKind: string;
  startMs: number;
  endMs: number;
}) =>
  coordinationKey({
    scope: "action-admission",
    slot: organizationId,
    suffix: `period:${hashSha256Hex(actionKind)}:${startMs}:${endMs}`,
  });

type ResolveActionPeriodBudgetOptions = {
  organizationId: SafeId<"organization">;
  identity?: ActionPeriodIdentity | undefined;
  policy?: ActionPeriodPolicy | undefined;
  nowMs: number;
};

export const resolveActionPeriodBudget = ({
  organizationId,
  identity,
  policy,
  nowMs,
}: ResolveActionPeriodBudgetOptions): Result<
  ActionPeriodBudget | null,
  ActionPeriodBudgetError
> => {
  const periodMs = policy?.periodMs ?? env.ACTION_ADMISSION_PERIOD_MS;
  const limit = policy?.limit ?? env.ACTION_ADMISSION_PERIOD_ACTIONS;
  if (periodMs === undefined && limit === undefined) {
    return Result.ok(null);
  }
  if (
    periodMs === undefined ||
    limit === undefined ||
    !Number.isSafeInteger(periodMs) ||
    periodMs <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !identity?.actionKind.trim() ||
    !identity.logicalPhaseId.trim()
  ) {
    return Result.err(
      new ActionPeriodBudgetError({
        message:
          "Action period configuration or logical phase identity is incomplete",
      }),
    );
  }
  // UTC windows are anchored to the Unix epoch, independent of host timezone.
  const startMs = Math.floor(nowMs / periodMs) * periodMs;
  const endMs = startMs + periodMs;
  if (!Number.isSafeInteger(endMs)) {
    return Result.err(
      new ActionPeriodBudgetError({ message: "Action period end is invalid" }),
    );
  }
  return Result.ok({
    key: periodKey({
      organizationId,
      actionKind: identity.actionKind,
      startMs,
      endMs,
    }),
    startMs,
    endMs,
    limit,
    phaseField: `phase:${hashSha256Hex(identity.logicalPhaseId)}`,
  });
};

const STALE_PERIOD_STATUS = -3;
const stalePeriodReplySchema = v.tuple([
  v.literal(STALE_PERIOD_STATUS),
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
]);

export const staleActionPeriodTime = (reply: unknown): number | null =>
  v.is(stalePeriodReplySchema, reply) ? reply[1] : null;

export const actionPeriodArguments = (
  budget: ActionPeriodBudget | null,
): string[] =>
  budget === null
    ? []
    : [
        String(budget.startMs),
        String(budget.endMs),
        String(budget.limit),
        budget.phaseField,
      ];

// Embedded in the concurrency acquire script after both pools have headroom.
// KEYS[3] is the single period hash; ARGV[5..8] stay fixed for this admission.
export const ACTION_PERIOD_ACQUIRE_SCRIPT = `
if KEYS[3] then
  if now < tonumber(ARGV[5]) or now >= tonumber(ARGV[6]) then return {${STALE_PERIOD_STATUS}, now} end
  local count = tonumber(redis.call("HGET", KEYS[3], "count") or "0")
  if count == nil or count < 0 or count ~= math.floor(count) then return -2 end
  local replay = redis.call("HEXISTS", KEYS[3], ARGV[8]) == 1
  if replay and count < 1 then return -2 end
  if count > tonumber(ARGV[7]) then return -1 end
  if not replay and count >= tonumber(ARGV[7]) then return -1 end
  if not replay then
    redis.call("HSET", KEYS[3], "count", count + 1, ARGV[8], "1")
  end
  redis.call("PEXPIREAT", KEYS[3], ARGV[6])
end
`;

// Checked when admitting a new phase, never while renewing already-admitted work.
export const ACTION_SERVICE_DEADLINE_EXPIRED = -4;
export const ACTION_SERVICE_DEADLINE_SCRIPT = `
if ARGV[9] and now >= tonumber(ARGV[9]) then return ${ACTION_SERVICE_DEADLINE_EXPIRED} end
`;

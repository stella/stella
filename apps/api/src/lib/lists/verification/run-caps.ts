import { panic, Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalListVerificationBudgets } from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import type { VerificationRunCaps } from "@/api/lib/lists/verification/run-cap-config";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";

const CAP_REFUSALS = {
  active: {
    message: "This organization has reached its active verification limit.",
    hint: "Wait for an active verification to finish, then retry lists.verifications.create.",
  },
  daily: {
    message: "This organization has reached its daily verification limit.",
    hint: "Retry lists.verifications.create after midnight in Europe/Prague.",
  },
} as const;

export class ListVerificationRunCapError extends TaggedError(
  "ListVerificationRunCapError",
)<{
  message: string;
  reason: "active" | "daily";
  hint: string;
}> {}

export const getVerificationRunCaps = (): VerificationRunCaps => ({
  active: env.LIST_VERIFICATION_ACTIVE_RUNS_MAX,
  startsPerDay: env.LIST_VERIFICATION_DAILY_STARTS_MAX,
});

type ReadVerificationBudgetArgs = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
};

/** Counters are organization-scoped even when the caller sees one matter. */
export const readVerificationBudget = async ({
  tx,
  organizationId,
}: ReadVerificationBudgetArgs) => {
  const budget = (
    await tx
      .select({
        active: legalListVerificationBudgets.activeRuns,
        activeLimit: legalListVerificationBudgets.activeLimit,
        dailyLimit: legalListVerificationBudgets.dailyLimit,
        starts: sql<number>`CASE WHEN ${legalListVerificationBudgets.startsDay} = stella_list_verification_day(clock_timestamp())
      THEN ${legalListVerificationBudgets.startsToday} ELSE 0 END`,
      })
      .from(legalListVerificationBudgets)
      .where(eq(legalListVerificationBudgets.organizationId, organizationId))
      .limit(1)
  ).at(0);
  if (budget === undefined) {
    panic("List verification run has no organization counter");
  }
  return budget;
};

type DecideVerificationBudgetArgs = {
  active: number;
  starts: number;
  caps: VerificationRunCaps;
  phase: "start" | "dispatch";
};

export const decideVerificationBudget = ({
  active,
  starts,
  caps,
  phase,
}: DecideVerificationBudgetArgs) => {
  const allowance = phase === "dispatch" ? 1 : 0;
  if (active >= caps.active + allowance) {
    return Result.err(
      new ListVerificationRunCapError({
        reason: "active",
        ...CAP_REFUSALS.active,
      }),
    );
  }
  if (starts >= caps.startsPerDay + allowance) {
    return Result.err(
      new ListVerificationRunCapError({
        reason: "daily",
        ...CAP_REFUSALS.daily,
      }),
    );
  }
  return Result.ok();
};

type CheckVerificationDispatchBudgetArgs = ReadVerificationBudgetArgs & {
  caps?: VerificationRunCaps;
};

export const checkVerificationDispatchBudget = async ({
  tx,
  organizationId,
  caps = getVerificationRunCaps(),
}: CheckVerificationDispatchBudgetArgs) => {
  const budget = await readVerificationBudget({ tx, organizationId });
  return decideVerificationBudget({
    active: budget.active,
    starts: budget.starts,
    caps: {
      active: Math.min(caps.active, budget.activeLimit),
      startsPerDay: Math.min(caps.startsPerDay, budget.dailyLimit),
    },
    phase: "dispatch",
  });
};

export const verificationCapErrorFromDatabase = (cause: unknown) => {
  for (const reason of ["active", "daily"] as const) {
    if (
      isPgConstraintError(
        cause,
        PG_ERROR.CHECK_VIOLATION,
        `legal_list_verification_${reason}_cap`,
      )
    ) {
      return new ListVerificationRunCapError({
        reason,
        ...CAP_REFUSALS[reason],
      });
    }
  }
  return null;
};

import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { ActionPeriodPolicy } from "@/api/lib/rate-limit/action-period-budget";

export type OrganizationActionState = Pick<
  typeof organizationAccessStates.$inferSelect,
  "state" | "evaluationEndsAt"
>;

export type OrganizationActionBudgetConfig = {
  periodMs: number | undefined;
  evaluationActions: number | undefined;
  selfManagedActions: number | undefined;
};

type ResolveOrganizationActionBudgetOptions = {
  state: OrganizationActionState | undefined;
  now: Date;
} & OrganizationActionBudgetConfig;

type OrganizationActionBudget =
  | {
      status: "resolved";
      policy: ActionPeriodPolicy;
      serviceDeadlineMs: number | null;
    }
  | { status: "not_enabled" }
  | { status: "unavailable" };

export const resolveOrganizationActionBudget = ({
  state,
  now,
  periodMs,
  evaluationActions,
  selfManagedActions,
}: ResolveOrganizationActionBudgetOptions): OrganizationActionBudget => {
  if (state === undefined) {
    return { status: "unavailable" };
  }
  let limit: number | undefined;
  let serviceDeadlineMs: number | null = null;
  switch (state.state) {
    case ORGANIZATION_ACCESS_STATE.evaluationEnded:
      return { status: "not_enabled" };
    case ORGANIZATION_ACCESS_STATE.evaluationPeriod:
      if (state.evaluationEndsAt === null || state.evaluationEndsAt <= now) {
        return { status: "not_enabled" };
      }
      serviceDeadlineMs = state.evaluationEndsAt.getTime();
      limit = evaluationActions;
      break;
    case ORGANIZATION_ACCESS_STATE.selfManagedKeys:
      limit = selfManagedActions;
      break;
    default:
      state.state satisfies never;
      return panic(
        `Unhandled organization access state: ${String(state.state)}`,
      );
  }
  if (
    periodMs === undefined ||
    !Number.isSafeInteger(periodMs) ||
    periodMs <= 0 ||
    limit === undefined ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    return { status: "unavailable" };
  }
  return { status: "resolved", policy: { periodMs, limit }, serviceDeadlineMs };
};

export const readOrganizationActionState = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
) =>
  await db
    .select({
      state: organizationAccessStates.state,
      evaluationEndsAt: organizationAccessStates.evaluationEndsAt,
    })
    .from(organizationAccessStates)
    .where(eq(organizationAccessStates.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));

type ReadAdmissionOrganizationStateOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export const readAdmissionOrganizationState = async ({
  organizationId,
  userId,
}: ReadAdmissionOrganizationStateOptions) => {
  // Admission runs outside handler transactions; defer opening its RLS scope
  // until an enabled service action needs the organization's persisted state.
  const { rlsDb } = await import("@/api/db/root");
  const { createMembershipScopedDb } = await import("@/api/db/scoped");
  const scopedDb = createMembershipScopedDb(rlsDb, {
    organizationId,
    userId,
    serverValidatedWorkspaceIds: [],
  });
  return await scopedDb(
    async (tx) => await readOrganizationActionState(tx, organizationId),
  );
};

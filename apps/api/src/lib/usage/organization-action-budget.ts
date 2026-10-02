import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { ActionPeriodPolicy } from "@/api/lib/rate-limit/action-period-budget";
import {
  CONFIGURED_ACCESS_STATE,
  configuredAccessDeadline,
} from "@/api/lib/usage/configured-access";
import {
  readOrganizationAccessSnapshot,
  type OrganizationAccessSnapshot,
} from "@/api/lib/usage/organization-access-snapshot";

export type OrganizationActionState = OrganizationAccessSnapshot;

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
    case CONFIGURED_ACCESS_STATE: {
      const access = state.configuredAccess;
      const deadline = configuredAccessDeadline(access);
      if (
        access.status === "disabled" ||
        deadline === null ||
        deadline <= now
      ) {
        return { status: "not_enabled" };
      }
      serviceDeadlineMs = deadline.getTime();
      limit = access.serviceActionsPerPeriod;
      break;
    }
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
      state satisfies never;
      return panic("Unhandled organization access state");
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
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
) =>
  await scopedDb(
    async (tx) => await readOrganizationAccessSnapshot(tx, organizationId),
  );

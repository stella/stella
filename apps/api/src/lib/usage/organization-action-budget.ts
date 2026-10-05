import { panic } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ACTION_SERVICE_CREDENTIALS,
  type ActionServiceCredentials,
} from "@/api/lib/rate-limit/action-kinds";
import {
  PER_KIND_PERIOD_SCOPE,
  type ActionPeriodPolicy,
  type ActionPeriodScope,
} from "@/api/lib/rate-limit/action-period-budget";
import {
  readFreeTier,
  type FreeTier,
  type OrganizationAccess,
} from "@/api/lib/usage/organization-access";
import {
  readOrganizationAccessSnapshot,
  type OrganizationAccessSnapshot,
} from "@/api/lib/usage/organization-access-snapshot";

/** Whose model key serves the organization's model dispatch. */
export const ORGANIZATION_MODEL_CREDENTIALS = {
  organization: "organization",
  managed: "managed",
} as const;

export type OrganizationModelCredentials =
  (typeof ORGANIZATION_MODEL_CREDENTIALS)[keyof typeof ORGANIZATION_MODEL_CREDENTIALS];

/** What admission reads once per action to resolve the organization's budget. */
export type OrganizationActionState = {
  snapshot: OrganizationAccessSnapshot | undefined;
  freeTier: FreeTier;
  modelCredentials: OrganizationModelCredentials;
};

export type OrganizationActionBudgetConfig = {
  periodMs: number | undefined;
  evaluationActions: number | undefined;
  selfManagedActions: number | undefined;
};

type ActionDrawsServiceBudgetOptions = {
  access: OrganizationAccess;
  serviceCredentials: ActionServiceCredentials;
  modelCredentials: OrganizationModelCredentials;
};

/**
 * Whether an admitted action draws from the organization's service budget.
 * On the free floor the budget covers managed work only: model work served
 * by the organization's own key is not counted. Every other standing counts
 * every service action, whichever key serves it.
 */
export const actionDrawsServiceBudget = ({
  access,
  serviceCredentials,
  modelCredentials,
}: ActionDrawsServiceBudgetOptions): boolean => {
  switch (access.type) {
    case "free":
      return !(
        serviceCredentials === ACTION_SERVICE_CREDENTIALS.organizationModel &&
        modelCredentials === ORGANIZATION_MODEL_CREDENTIALS.organization
      );
    case "paid":
    case "evaluation":
    case "self_managed_keys":
    case "ended":
    case "unavailable":
      return true;
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

type ResolveOrganizationActionBudgetOptions = {
  access: OrganizationAccess;
} & OrganizationActionBudgetConfig;

type OrganizationActionBudget =
  | {
      status: "resolved";
      policy: ActionPeriodPolicy;
      scope: ActionPeriodScope;
      serviceDeadlineMs: number | null;
    }
  | { status: "not_enabled" }
  | { status: "unavailable" };

/** The free floor's one period count, shared by every counted kind. */
export const FREE_TIER_PERIOD_SCOPE = {
  type: "pooled",
  poolKey: "free",
} as const satisfies ActionPeriodScope;

type AccessBudgetLimit =
  | {
      status: "limited";
      limit: number | undefined;
      scope: ActionPeriodScope;
      serviceDeadlineMs: number | null;
    }
  | { status: "not_enabled" }
  | { status: "unavailable" };

const accessBudgetLimit = ({
  access,
  evaluationActions,
  selfManagedActions,
}: ResolveOrganizationActionBudgetOptions): AccessBudgetLimit => {
  switch (access.type) {
    case "paid":
      return {
        status: "limited",
        limit: access.serviceActionsPerPeriod,
        scope: PER_KIND_PERIOD_SCOPE,
        serviceDeadlineMs: access.deadline.getTime(),
      };
    case "evaluation":
      return {
        status: "limited",
        limit: evaluationActions,
        scope: PER_KIND_PERIOD_SCOPE,
        serviceDeadlineMs: access.endsAt.getTime(),
      };
    // The free floor never expires; it ends only when the organization
    // regains paid access. Its budget is one count across every kind.
    case "free":
      return {
        status: "limited",
        limit: access.serviceActionsPerPeriod,
        scope: FREE_TIER_PERIOD_SCOPE,
        serviceDeadlineMs: null,
      };
    case "self_managed_keys":
      return {
        status: "limited",
        limit: selfManagedActions,
        scope: PER_KIND_PERIOD_SCOPE,
        serviceDeadlineMs: null,
      };
    case "ended":
      return { status: "not_enabled" };
    case "unavailable":
      return { status: "unavailable" };
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

export const resolveOrganizationActionBudget = (
  options: ResolveOrganizationActionBudgetOptions,
): OrganizationActionBudget => {
  const resolved = accessBudgetLimit(options);
  switch (resolved.status) {
    case "not_enabled":
    case "unavailable":
      return { status: resolved.status };
    case "limited":
      break;
    default:
      resolved satisfies never;
      return panic("Unhandled organization budget limit");
  }
  const { periodMs } = options;
  const { limit, scope, serviceDeadlineMs } = resolved;
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
  return {
    status: "resolved",
    policy: { periodMs, limit },
    scope,
    serviceDeadlineMs,
  };
};

/**
 * A stored AI config means every model dispatch runs on the organization's
 * own key: role and by-id model resolution never fall back to the managed
 * provider for an organization with a config, and an undecryptable config
 * refuses the work rather than serving it managed.
 */
const readOrganizationModelCredentials = async (
  tx: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<OrganizationModelCredentials> => {
  const row = await tx
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        isNotNull(organizationSettings.aiConfigEncrypted),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));
  return row === undefined
    ? ORGANIZATION_MODEL_CREDENTIALS.managed
    : ORGANIZATION_MODEL_CREDENTIALS.organization;
};

export const readOrganizationActionState = async (
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<OrganizationActionState> =>
  await scopedDb(async (tx) => ({
    snapshot: await readOrganizationAccessSnapshot(tx, organizationId),
    freeTier: await readFreeTier(tx),
    modelCredentials: await readOrganizationModelCredentials(
      tx,
      organizationId,
    ),
  }));

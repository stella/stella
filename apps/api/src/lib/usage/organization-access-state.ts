/**
 * The persisted per-organization access state (see
 * `organization_access_states`). While `FEATURE_ORG_ACCESS_STATE` is off
 * nothing here is read, so model resolution is unchanged; the state is still
 * recorded at organization creation so enabling the flag later changes no
 * existing organization's standing.
 */

import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  readFreeTier,
  resolveOrganizationAccess,
  type OrganizationAccess,
} from "@/api/lib/usage/organization-access";
import { readOrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";

/**
 * Whether an organization without its own AI config may run on the instance
 * provider. An unresolvable standing (a missing state row or free policy)
 * fails closed: absence is a fault, not a default.
 */
export const allowsInstanceModels = (access: OrganizationAccess): boolean => {
  switch (access.type) {
    case "paid":
    case "evaluation":
    case "free":
      return true;
    case "self_managed_keys":
    case "ended":
    case "unavailable":
      return false;
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

/**
 * The instance-provider gate for an organization whose AI config is null.
 * Always true while the flag is off, without a query.
 */
export const mayUseInstanceModels = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<boolean> => {
  if (!isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE")) {
    return true;
  }
  const snapshot = await readOrganizationAccessSnapshot(db, organizationId);
  const freeTier = await readFreeTier(db);
  return allowsInstanceModels(
    resolveOrganizationAccess({ snapshot, now: new Date(), freeTier }),
  );
};

type OrganizationAccessStateChange = {
  organizationId: SafeId<"organization">;
  now: Date;
};

/**
 * Records a new organization's state once. With the flag on it starts the
 * evaluation period; with it off the organization keeps today's
 * self-managed-keys path. The insert never overwrites, so a replayed call
 * cannot start a second evaluation or move an existing organization.
 */
export const recordNewOrganizationAccessState = async (
  db: Pick<Transaction, "insert">,
  { organizationId, now }: OrganizationAccessStateChange,
): Promise<void> => {
  const values = isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE")
    ? {
        organizationId,
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationStartedAt: now,
        evaluationEndsAt: addDays(
          now,
          // The env invariant refuses to boot with the flag on and no length.
          env.ORG_EVALUATION_PERIOD_DAYS ??
            panic("ORG_EVALUATION_PERIOD_DAYS is unset"),
        ),
      }
    : {
        organizationId,
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      };
  await db
    .insert(organizationAccessStates)
    .values(values)
    .onConflictDoNothing({ target: organizationAccessStates.organizationId });
};

const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * DAY_IN_MS);

/**
 * Ends a running evaluation period. Returns whether this call ended it; a
 * repeated call, or one for an organization in any other state, changes
 * nothing.
 */
export const endOrganizationEvaluation = async (
  db: Pick<Transaction, "update">,
  { organizationId, now }: OrganizationAccessStateChange,
): Promise<boolean> => {
  const ended = await db
    .update(organizationAccessStates)
    .set({
      state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
      evaluationEndedAt: now,
    })
    .where(
      and(
        eq(organizationAccessStates.organizationId, organizationId),
        eq(
          organizationAccessStates.state,
          ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        ),
      ),
    )
    .returning({ organizationId: organizationAccessStates.organizationId });
  return ended.length > 0;
};

/**
 * Records `self_managed_keys` for every organization that has no state yet.
 * An organization gets no row when a process without the creation step
 * created it (an older task during a rolling deploy); while the state is not
 * enforced, the self-managed-keys path is exactly what it had. Existing rows
 * are never changed, so this is safe to run repeatedly and concurrently.
 */
export const recordMissingOrganizationAccessStates = async (
  db: Pick<Transaction, "execute">,
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO ${organizationAccessStates} (organization_id, state)
    SELECT ${organization.id}, ${ORGANIZATION_ACCESS_STATE.selfManagedKeys}
    FROM ${organization}
    ON CONFLICT (organization_id) DO NOTHING
  `);
};

/**
 * The recurring convergence step: while the flag is off, every organization
 * without a state was created without enforcement. With the flag on nothing
 * is recorded, so a missing row stays denied.
 */
export const recordMissingOrganizationAccessStatesWhileUnenforced = async (
  db: Pick<Transaction, "execute">,
): Promise<void> => {
  if (isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE")) {
    return;
  }
  await recordMissingOrganizationAccessStates(db);
};

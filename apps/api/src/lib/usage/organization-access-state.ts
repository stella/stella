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
import type { ScopedDb } from "@/api/db/safe-db";
import {
  ORGANIZATION_ACCESS_STATE,
  ORGANIZATION_ACCESS_STATE_ORIGIN,
  organizationAccessStates,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { defineLifecycle, transitionLifecycle } from "@/api/lib/db/transitions";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  MANAGED_MODEL_TIER,
  MANAGED_MODEL_TIER_BY_ACCESS,
  type ManagedModelTier,
} from "@/api/lib/usage/managed-model-tier";
import {
  type OrganizationAccess,
  readFreeTier,
  resolveOrganizationAccess,
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

/**
 * The organization's managed model tier now, inside a transaction the caller
 * holds. Standard without a query while `FEATURE_FREE_TIER` is off: no
 * organization can stand on the free floor then.
 */
export const readManagedModelTierOnTx = async (
  tx: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<ManagedModelTier> => {
  if (!isDeploymentFeatureEnabled("FEATURE_FREE_TIER")) {
    return MANAGED_MODEL_TIER.standard;
  }
  const access = resolveOrganizationAccess({
    snapshot: await readOrganizationAccessSnapshot(tx, organizationId),
    now: new Date(),
    freeTier: await readFreeTier(tx),
  });
  return MANAGED_MODEL_TIER_BY_ACCESS[access.type];
};

/** {@link readManagedModelTierOnTx}, opening no transaction while the flag is off. */
export const readManagedModelTier = async (
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<ManagedModelTier> =>
  isDeploymentFeatureEnabled("FEATURE_FREE_TIER")
    ? await scopedDb(
        async (tx) => await readManagedModelTierOnTx(tx, organizationId),
      )
    : MANAGED_MODEL_TIER.standard;

type OrganizationAccessStateChange = {
  organizationId: SafeId<"organization">;
  now: Date;
};

const ORGANIZATION_EVALUATION_LIFECYCLE = defineLifecycle({
  table: organizationAccessStates,
  key: "organizationId",
  graphs: {
    state: {
      edges: {
        [ORGANIZATION_ACCESS_STATE.selfManagedKeys]: [
          ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        ],
        [ORGANIZATION_ACCESS_STATE.evaluationPeriod]: [
          ORGANIZATION_ACCESS_STATE.evaluationEnded,
        ],
        [ORGANIZATION_ACCESS_STATE.evaluationEnded]: [],
      },
      terminal: [ORGANIZATION_ACCESS_STATE.evaluationEnded],
    },
  },
});

/**
 * Records a new organization's state once. With the flag on it starts the
 * evaluation period; with it off the organization keeps today's
 * self-managed-keys path. An enabled creation supersedes only a legacy
 * reconciler row, which closes the rolling-deployment race between those
 * writers. A replayed creation cannot restart or move a final state.
 */
export const recordNewOrganizationAccessState = async (
  db: Pick<Transaction, "insert">,
  { organizationId, now }: OrganizationAccessStateChange,
): Promise<void> => {
  const enforced = isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE");
  if (!enforced) {
    // audit: skip - organization creation records the initial access state
    await db
      .insert(organizationAccessStates)
      .values({
        organizationId,
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
      })
      .onConflictDoNothing({ target: organizationAccessStates.organizationId });
    return;
  }
  const evaluationEndsAt = addDays(
    now,
    // The env invariant refuses to boot with the flag on and no length.
    env.ORG_EVALUATION_PERIOD_DAYS ??
      panic("ORG_EVALUATION_PERIOD_DAYS is unset"),
  );
  const legacyReconcileRow =
    and(
      eq(
        organizationAccessStates.state,
        ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      ),
      eq(
        organizationAccessStates.origin,
        ORGANIZATION_ACCESS_STATE_ORIGIN.legacyReconcile,
      ),
    ) ?? panic("Expected the legacy access-state conflict predicate");
  // audit: skip - organization creation records the initial access state
  await db
    .insert(organizationAccessStates)
    .values({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
      evaluationStartedAt: now,
      evaluationEndsAt,
    })
    .onConflictDoUpdate({
      target: organizationAccessStates.organizationId,
      set: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
        evaluationStartedAt: now,
        evaluationEndsAt,
        evaluationEndedAt: null,
        updatedAt: now,
      },
      setWhere: legacyReconcileRow,
    });
};

const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * DAY_IN_MS);

/**
 * Ends a running evaluation period. Returns whether this call ended it; a
 * repeated call, or one for an organization in any other state, changes
 * nothing.
 */
export const endOrganizationEvaluation = async (
  db: Transaction,
  { organizationId, now }: OrganizationAccessStateChange,
): Promise<boolean> => {
  const ended = await transitionLifecycle({
    tx: db,
    spec: ORGANIZATION_EVALUATION_LIFECYCLE,
    id: organizationId,
    moves: {
      state: {
        from: [ORGANIZATION_ACCESS_STATE.evaluationPeriod],
        to: ORGANIZATION_ACCESS_STATE.evaluationEnded,
      },
    },
    set: { evaluationEndedAt: now },
    recordTransitionAuditEvent: async () => await Promise.resolve(),
  });
  return ended.type === "transitioned";
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
    INSERT INTO ${organizationAccessStates} (organization_id, state, origin)
    SELECT ${organization.id}, ${ORGANIZATION_ACCESS_STATE.selfManagedKeys}, ${ORGANIZATION_ACCESS_STATE_ORIGIN.legacyReconcile}
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

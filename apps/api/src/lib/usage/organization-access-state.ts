/**
 * The persisted per-organization access state (see
 * `organization_access_states`). While `FEATURE_ORG_ACCESS_STATE` is off
 * nothing here is read, so model resolution is unchanged; the state is still
 * recorded at organization creation so enabling the flag later changes no
 * existing organization's standing.
 */

import { panic } from "better-result";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
} from "@/api/db/schema";
import { env } from "@/api/env";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  recordAuditGroups,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { lockOrganizationSettingsWrites } from "@/api/lib/db/aggregate-lock";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionScopedBatch } from "@/api/lib/db/transitions";
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
const EVALUATION_END_AUDIT_SOURCE = "organization-evaluation-end";

type EndOrganizationEvaluationOptions = OrganizationAccessStateChange & {
  /** The operator recorded on the audit event. */
  actor: string;
};

export const endOrganizationEvaluation = async (
  db: Transaction,
  { organizationId, now, actor }: EndOrganizationEvaluationOptions,
): Promise<boolean> => {
  const ended = await transitionScopedBatch({
    tx: db,
    spec: TRANSITIONS.organizationAccessStates,
    identities: [{ organizationId }],
    options: {
      from: [ORGANIZATION_ACCESS_STATE.evaluationPeriod],
      to: ORGANIZATION_ACCESS_STATE.evaluationEnded,
      set: { evaluationEndedAt: now },
    },
    recordTransitionAuditEvent: async (auditTx, rows) => {
      if (rows.length === 0) {
        return;
      }
      await recordAuditGroups({
        tx: auditTx,
        groups: [
          {
            bindings: {
              organizationId,
              workspaceId: null,
              userId: actor,
              execution: {
                performer: { type: "service", id: actor, name: actor },
                trigger: {
                  type: "system",
                  source: EVALUATION_END_AUDIT_SOURCE,
                },
              },
            },
            events: [
              {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE,
                resourceId: organizationId,
                changes: {
                  state: {
                    old: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
                    new: ORGANIZATION_ACCESS_STATE.evaluationEnded,
                  },
                },
              },
            ],
          },
        ],
      });
    },
  });
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
 * Moves the blanket-backfilled organizations without an organization AI
 * configuration onto the free floor. The encrypted blob's presence is enough:
 * its validated plaintext always contains at least one provider, so this path
 * neither needs nor attempts to decrypt it.
 */
const KEYLESS_MOVE_AUDIT_SOURCE = "keyless-organization-move";

type MoveKeylessOrganizationsOptions = {
  now: Date;
  /** The operator recorded on each moved organization's audit event. */
  actor: string;
};

const selectKeylessOrganizations = async (
  db: Transaction,
  within?: readonly SafeId<"organization">[],
) =>
  await db
    .select({ id: organizationAccessStates.organizationId })
    .from(organizationAccessStates)
    .where(
      and(
        eq(
          organizationAccessStates.state,
          ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        ),
        within === undefined
          ? undefined
          : inArray(organizationAccessStates.organizationId, [...within]),
        notExists(
          db
            .select({ organizationId: organizationSettings.organizationId })
            .from(organizationSettings)
            .where(
              and(
                eq(
                  organizationSettings.organizationId,
                  organizationAccessStates.organizationId,
                ),
                sql`${organizationSettings.aiConfigEncrypted} IS NOT NULL`,
              ),
            ),
        ),
      ),
    );

export const moveKeylessOrganizationsToFree = async (
  db: Transaction,
  { now, actor }: MoveKeylessOrganizationsOptions,
): Promise<SafeId<"organization">[]> => {
  const preliminary = await selectKeylessOrganizations(db);
  if (preliminary.length === 0) {
    return [];
  }
  const preliminaryIds = preliminary.map(({ id }) => id);
  // Configuration writes committed before the lock are seen by the re-read;
  // later ones wait for this transaction.
  await lockOrganizationSettingsWrites({
    tx: db,
    organizationIds: preliminaryIds,
  });
  const candidates = await selectKeylessOrganizations(db, preliminaryIds);

  const moved = await transitionScopedBatch({
    tx: db,
    spec: TRANSITIONS.organizationAccessStates,
    identities: candidates.map(({ id }) => ({ organizationId: id })),
    options: {
      from: [ORGANIZATION_ACCESS_STATE.selfManagedKeys],
      to: ORGANIZATION_ACCESS_STATE.evaluationEnded,
      set: { evaluationEndedAt: now },
    },
    recordTransitionAuditEvent: async (auditTx, rows) => {
      const movedIds = candidates.filter(({ id }) =>
        rows.some(({ identity }) => identity["organizationId"] === id),
      );
      await recordAuditGroups({
        tx: auditTx,
        groups: movedIds.map(({ id }) => ({
          bindings: {
            organizationId: id,
            workspaceId: null,
            userId: actor,
            execution: {
              performer: { type: "service", id: actor, name: actor },
              trigger: { type: "system", source: KEYLESS_MOVE_AUDIT_SOURCE },
            },
          },
          events: [
            {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE,
              resourceId: id,
              changes: {
                state: {
                  old: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
                  new: ORGANIZATION_ACCESS_STATE.evaluationEnded,
                },
              },
            },
          ],
        })),
      });
    },
  });
  return candidates
    .filter(({ id }) =>
      moved.some(({ identity }) => identity["organizationId"] === id),
    )
    .map(({ id }) => id);
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

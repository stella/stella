import { panic } from "better-result";
import { eq, getColumns } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  organizationAccessStates,
  organizationConfiguredAccess,
  usageEntitlements,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  CONFIGURED_ACCESS_STATE,
  type ConfiguredAccess,
} from "@/api/lib/usage/configured-access";

const originalAccessSnapshotColumns = {
  state: organizationAccessStates.state,
  evaluationEndsAt: organizationAccessStates.evaluationEndsAt,
};

export const readOriginalOrganizationAccessSnapshot = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
) =>
  await db
    .select(originalAccessSnapshotColumns)
    .from(organizationAccessStates)
    .where(eq(organizationAccessStates.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));

export type OriginalOrganizationAccessSnapshot = Pick<
  typeof organizationAccessStates.$inferSelect,
  "state" | "evaluationEndsAt"
>;

export type OrganizationAccessSnapshot =
  | OriginalOrganizationAccessSnapshot
  | {
      state: typeof CONFIGURED_ACCESS_STATE;
      configuredAccess: ConfiguredAccess;
      /** The recorded standing the configured access overlays. */
      original: OriginalOrganizationAccessSnapshot | undefined;
    };

export const decodeConfiguredAccess = (
  row: typeof organizationConfiguredAccess.$inferSelect,
): ConfiguredAccess => {
  if (row.configuredAccessStatus === "disabled") {
    return { status: "disabled" };
  }
  if (
    row.configuredPeriodEndsAt === null ||
    row.serviceActionsPerPeriod === null
  ) {
    return panic("Configured access violates persisted shape");
  }
  switch (row.configuredAccessStatus) {
    case "active":
    case "ending":
      return {
        status: row.configuredAccessStatus,
        periodEndsAt: row.configuredPeriodEndsAt,
        serviceActionsPerPeriod: row.serviceActionsPerPeriod,
      };
    case "payment_retry":
      return {
        status: row.configuredAccessStatus,
        periodEndsAt: row.configuredPeriodEndsAt,
        retryEndsAt:
          row.paymentRetryEndsAt ?? panic("Retry deadline is missing"),
        serviceActionsPerPeriod: row.serviceActionsPerPeriod,
      };
    default:
      row.configuredAccessStatus satisfies never;
      return panic("Unhandled configured access status");
  }
};

export type ConfiguredAccessSource = Pick<
  typeof usageEntitlements.$inferSelect,
  | "status"
  | "cancelAtPeriodEnd"
  | "hostedLastEventAt"
  | "hostedEntitlementExternalId"
  | "hostedEntitlementCreatedAt"
>;

type ConfiguredAccessSourceOptions = {
  configured: typeof organizationConfiguredAccess.$inferSelect;
  original: Awaited<ReturnType<typeof readOriginalOrganizationAccessSnapshot>>;
  source: ConfiguredAccessSource;
};

export const configuredAccessSourceMatches = ({
  configured,
  original,
  source,
}: ConfiguredAccessSourceOptions) =>
  configured.sourceEntitlementExternalId ===
    source.hostedEntitlementExternalId &&
  configured.sourceEntitlementCreatedAt?.getTime() ===
    source.hostedEntitlementCreatedAt?.getTime() &&
  configured.sourceSignature === JSON.stringify(original ?? null) &&
  configured.sourceEntitlementStatus === source.status &&
  configured.sourceCancelAtPeriodEnd === source.cancelAtPeriodEnd &&
  configured.sourceEventAt?.getTime() === source.hostedLastEventAt?.getTime();

export const readOrganizationAccessSnapshot = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
) => {
  const original = await readOriginalOrganizationAccessSnapshot(
    db,
    organizationId,
  );
  if (isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS")) {
    const source = await db
      .select({
        status: usageEntitlements.status,
        cancelAtPeriodEnd: usageEntitlements.cancelAtPeriodEnd,
        hostedLastEventAt: usageEntitlements.hostedLastEventAt,
        hostedEntitlementExternalId:
          usageEntitlements.hostedEntitlementExternalId,
        hostedEntitlementCreatedAt:
          usageEntitlements.hostedEntitlementCreatedAt,
        configured: getColumns(organizationConfiguredAccess),
      })
      .from(usageEntitlements)
      .leftJoin(
        organizationConfiguredAccess,
        eq(
          organizationConfiguredAccess.organizationId,
          usageEntitlements.organizationId,
        ),
      )
      .where(eq(usageEntitlements.organizationId, organizationId))
      .limit(1)
      .then((rows) => rows.at(0));
    if (source === undefined) {
      return original;
    }
    if (source.status === "cancelled" && !source.cancelAtPeriodEnd) {
      return {
        state: CONFIGURED_ACCESS_STATE,
        configuredAccess: { status: "disabled" },
        original,
      } as const satisfies OrganizationAccessSnapshot;
    }
    const configured = source.configured;
    // The signature and the off-state read share their evaluated projection;
    // unrelated persistence changes cannot invalidate a valid overlay.
    if (
      configured !== null &&
      configuredAccessSourceMatches({ configured, original, source })
    ) {
      return {
        state: CONFIGURED_ACCESS_STATE,
        configuredAccess: decodeConfiguredAccess(configured),
        original,
      } as const satisfies OrganizationAccessSnapshot;
    }
  }
  return original;
};

/**
 * Per-event handlers for the hosted usage webhook adapter.
 *
 * Each handler takes a typed payload and a transaction, mutates
 * entitlement/allocation state, and returns a discriminated result.
 * Receive-side concerns (signature verification, dedup, HTTP
 * status mapping) live in `receive.ts`.
 *
 * Ownership rule (per /conventions-security): organisation_id is
 * resolved by joining on provider account / entitlement ids
 * recorded on the local `usage_entitlements` row. Provider metadata is
 * only trusted on the first entitlement mapping or after the
 * local account id has already been mapped to an organisation.
 */

import { panic, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { member, organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  hostedCheckoutClaims,
  usagePolicies,
  usageEntitlements,
  CLOSED_USAGE_ENTITLEMENT_STATUSES,
  usageSeatAssignments,
} from "@/api/db/schema";
import type { UsageEntitlementStatus, UsagePolicyKind } from "@/api/db/schema";
import { env } from "@/api/env";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import type { DispatchOutcome } from "@/api/lib/hosted-usage-provider/dispatch-outcome";
import type {
  HostedUsageWebhookEvent,
  HostedUsageAllocationPayload,
  HostedUsageEntitlementPayload,
} from "@/api/lib/hosted-usage-provider/event-schemas";
import {
  polarEntitlementStatusSchema,
  type PolarEntitlementStatus,
} from "@/api/lib/hosted-usage-provider/polar/contract";
import { recordWebhookAuditEvent } from "@/api/lib/hosted-usage-provider/webhook-store";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import {
  lockAssignmentCapacity,
  trimAssignmentsToCapacity,
} from "@/api/lib/usage/assignment-capacity";
import type { ConfiguredAccessEvent } from "@/api/lib/usage/configured-access";
import { applyConfiguredAccessEvent } from "@/api/lib/usage/configured-access-store";
import { allocateUsage } from "@/api/lib/usage/usage-ledger";

export type DispatchMode = "live" | "replay_apply" | "replay_dry_run";

type PolicyLookup = {
  id: SafeId<"usagePolicy">;
  monthlyUsageUnits: number;
  serviceActionsPerPeriod: number | null;
};

const resolvePolicyByHostedPolicyRef = async (
  tx: Transaction,
  hostedPolicyRef: string,
  expectedKind: UsagePolicyKind,
): Promise<PolicyLookup | null> => {
  const rows = await tx
    .select({
      id: usagePolicies.id,
      monthlyUsageUnits: usagePolicies.monthlyUsageUnits,
      serviceActionsPerPeriod: usagePolicies.serviceActionsPerPeriod,
    })
    .from(usagePolicies)
    .where(
      and(
        eq(usagePolicies.hostedPolicyRef, hostedPolicyRef),
        eq(usagePolicies.kind, expectedKind),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
};

type ExistingEntitlement = {
  id: SafeId<"usageEntitlement">;
  organizationId: SafeId<"organization">;
  source: "hosted" | "manual";
  usagePolicyId: SafeId<"usagePolicy">;
  hostedLastEventAt: Date | null;
  hostedEntitlementCreatedAt: Date | null;
  hostedEntitlementExternalId: string | null;
  status: UsageEntitlementStatus;
  cancelAtPeriodEnd: boolean;
  seats: number;
  hostedPeakSeats: number | null;
  currentPeriodStart: Date;
};

/**
 * Highest seat count already granted capacity inside the row's current
 * period. Null `hostedPeakSeats` (pre-column rows) reads as the row's
 * seat count: those seats were granted by the period's periodic
 * allocation.
 */
const peakSeatsOf = (existing: ExistingEntitlement): number =>
  Math.max(existing.seats, existing.hostedPeakSeats ?? existing.seats);

/**
 * Peak to store on the row after applying an event: within the same
 * period the peak only rises; a new period resets it to the event's
 * seat count.
 */
const nextPeakSeats = (
  existing: ExistingEntitlement,
  seats: number,
  periodStart: Date,
): number =>
  existing.currentPeriodStart.getTime() === periodStart.getTime()
    ? Math.max(peakSeatsOf(existing), seats)
    : seats;

/**
 * Provider-reported occurrence time, or null when absent/unparseable.
 * The neutral schema already validates ISO shape; the NaN check is a
 * boundary guard only.
 */
const parseOccurredAt = (payload: {
  occurred_at?: string | undefined;
}): Date | null => {
  if (payload.occurred_at === undefined) {
    return null;
  }
  const parsed = new Date(payload.occurred_at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

class HostedEventOrderingConflict extends TaggedError(
  "HostedEventOrderingConflict",
)<{
  message: string;
}> {}

const orderingConflict = failureSink({
  event: "usage_provider.webhook.ordering_conflict",
  expected: [],
});

const TERMINAL_PROVIDER_STATUSES = new Set([
  "canceled",
  "unpaid",
  "incomplete_expired",
]);

type StaleProviderEventParams = {
  mode: DispatchMode;
  existing: ExistingEntitlement;
  payload: HostedUsageEntitlementPayload;
  occurredAt: Date | null;
};

const isStaleProviderEvent = ({
  mode,
  existing,
  payload,
  occurredAt,
}: StaleProviderEventParams): boolean => {
  // Creation identifies an external generation; modification time orders
  // only the events inside that generation.
  if (payload.id !== existing.hostedEntitlementExternalId) {
    const createdAt =
      payload.created_at === undefined ? null : new Date(payload.created_at);
    if (
      createdAt !== null &&
      existing.hostedEntitlementCreatedAt !== null &&
      createdAt.getTime() !== existing.hostedEntitlementCreatedAt.getTime()
    ) {
      return createdAt < existing.hostedEntitlementCreatedAt;
    }
    if (
      createdAt !== null &&
      existing.hostedEntitlementCreatedAt === null &&
      occurredAt !== null &&
      existing.hostedLastEventAt !== null &&
      occurredAt.getTime() !== existing.hostedLastEventAt.getTime()
    ) {
      return occurredAt < existing.hostedLastEventAt;
    }
    if (mode !== "replay_dry_run") {
      observeFailure(
        new HostedEventOrderingConflict({
          message:
            "Hosted event generation is ambiguous; operator reconciliation required",
        }),
        {
          sink: orderingConflict,
          ctx: {
            source: "usage_provider.webhook.ordering",
            entityId: existing.id,
          },
        },
      );
    }
    // An unversioned incoming generation cannot displace a known one.
    // Existing unversioned rows retain their event-clock fallback only when
    // that clock distinguishes the events.
    return (
      existing.hostedEntitlementCreatedAt !== null ||
      occurredAt === null ||
      existing.hostedLastEventAt === null ||
      occurredAt.getTime() === existing.hostedLastEventAt.getTime() ||
      occurredAt < existing.hostedLastEventAt
    );
  }
  if (occurredAt === null || existing.hostedLastEventAt === null) {
    return false;
  }
  const eventTime = occurredAt.getTime();
  const lastTime = existing.hostedLastEventAt.getTime();
  if (eventTime !== lastTime) {
    return eventTime < lastTime;
  }
  return equalVersionIsStale({ existing, payload });
};

const equalVersionIsStale = ({
  existing,
  payload,
}: Pick<StaleProviderEventParams, "existing" | "payload">): boolean =>
  // At equal versions, terminal/cancellation facts dominate an active replay.
  (isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS") &&
    existing.status === "past_due" &&
    payload.status === "active" &&
    payload.cancel_at_period_end !== true) ||
  (existing.status === "paused" &&
    payload.status !== "paused" &&
    !TERMINAL_PROVIDER_STATUSES.has(payload.status)) ||
  (existing.status === "cancelled" &&
    (payload.status !== "canceled" || payload.cancel_at_period_end === true)) ||
  (existing.cancelAtPeriodEnd &&
    payload.cancel_at_period_end !== true &&
    payload.status !== "canceled" &&
    !(
      isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS") &&
      payload.status === "past_due"
    ));

const cancellationFlagAtVersion = ({
  existing,
  payload,
  occurredAt,
}: Omit<StaleProviderEventParams, "mode">) =>
  (payload.cancel_at_period_end ?? false) ||
  (isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS") &&
    existing.cancelAtPeriodEnd &&
    occurredAt !== null &&
    existing.hostedLastEventAt?.getTime() === occurredAt.getTime());

const lastEventPatch = (
  existing: ExistingEntitlement,
  occurredAt: Date | null,
): { hostedLastEventAt?: Date } =>
  occurredAt !== null &&
  (existing.hostedLastEventAt === null ||
    occurredAt > existing.hostedLastEventAt)
    ? { hostedLastEventAt: occurredAt }
    : {};

const findEntitlementByHostedExternalId = async (
  tx: Transaction,
  hostedEntitlementExternalId: string,
): Promise<ExistingEntitlement | null> => {
  const rows = await tx
    .select({
      id: usageEntitlements.id,
      organizationId: usageEntitlements.organizationId,
      source: usageEntitlements.source,
      usagePolicyId: usageEntitlements.usagePolicyId,
      hostedLastEventAt: usageEntitlements.hostedLastEventAt,
      hostedEntitlementCreatedAt: usageEntitlements.hostedEntitlementCreatedAt,
      hostedEntitlementExternalId:
        usageEntitlements.hostedEntitlementExternalId,
      status: usageEntitlements.status,
      cancelAtPeriodEnd: usageEntitlements.cancelAtPeriodEnd,
      seats: usageEntitlements.seats,
      hostedPeakSeats: usageEntitlements.hostedPeakSeats,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
    })
    .from(usageEntitlements)
    .where(
      eq(
        usageEntitlements.hostedEntitlementExternalId,
        hostedEntitlementExternalId,
      ),
    )
    .limit(1)
    // Row lock: concurrent deliveries for one entitlement must
    // serialize, or two seat-increase events can both read the same
    // peak and grant overlapping deltas. The waiter re-reads the row
    // after the winner commits, so it sees the updated peak.
    .for("update");
  return rows.at(0) ?? null;
};

const resolveSeatScopeUserId = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  candidate: string | undefined,
): Promise<string | null> => {
  if (!candidate) {
    return null;
  }
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, candidate),
      ),
    )
    .limit(1);
  return rows.at(0)?.userId ?? null;
};

type EntitlementOwnerLookup =
  | { type: "account"; accountRef: string }
  | { type: "organization"; organizationId: SafeId<"organization"> };

const findEntitlementByOwner = async (
  tx: Transaction,
  owner: EntitlementOwnerLookup,
): Promise<ExistingEntitlement | null> => {
  const rows = await tx
    .select({
      id: usageEntitlements.id,
      organizationId: usageEntitlements.organizationId,
      source: usageEntitlements.source,
      usagePolicyId: usageEntitlements.usagePolicyId,
      hostedLastEventAt: usageEntitlements.hostedLastEventAt,
      hostedEntitlementCreatedAt: usageEntitlements.hostedEntitlementCreatedAt,
      hostedEntitlementExternalId:
        usageEntitlements.hostedEntitlementExternalId,
      status: usageEntitlements.status,
      cancelAtPeriodEnd: usageEntitlements.cancelAtPeriodEnd,
      seats: usageEntitlements.seats,
      hostedPeakSeats: usageEntitlements.hostedPeakSeats,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
    })
    .from(usageEntitlements)
    .where(
      owner.type === "account"
        ? eq(usageEntitlements.hostedAccountRef, owner.accountRef)
        : eq(usageEntitlements.organizationId, owner.organizationId),
    )
    .limit(1)
    // Same serialization rationale as the external-id finder above.
    .for("update");
  return rows.at(0) ?? null;
};

/**
 * Whether an organization's hosted entitlement in each status admits a
 * further provider subscription. A subscription event under another
 * provider id while the mapped one blocks means the organization holds
 * two live subscriptions.
 */
const SECOND_SUBSCRIPTION_DISPOSITION_BY_STATUS = {
  trialing: "admits",
  active: "blocks",
  past_due: "blocks",
  cancelled: "admits",
  paused: "blocks",
} as const satisfies Record<UsageEntitlementStatus, "admits" | "blocks">;

const SECOND_LIVE_SUBSCRIPTION_EVENT =
  "usage_provider.webhook.second_live_subscription";

type SecondLiveSubscriptionSignalOptions = {
  mode: DispatchMode;
  mapped: ExistingEntitlement;
  payload: HostedUsageEntitlementPayload;
};

/**
 * Emit one operator signal when a non-terminal subscription event resolves
 * to an organization whose entitlement is live under a different provider
 * subscription. The entitlement outcome stays with the caller.
 */
const signalSecondLiveSubscription = ({
  mode,
  mapped,
  payload,
}: SecondLiveSubscriptionSignalOptions): void => {
  const liveSubscriptionId = mapped.hostedEntitlementExternalId;
  if (
    mode === "replay_dry_run" ||
    liveSubscriptionId === null ||
    liveSubscriptionId === payload.id ||
    TERMINAL_PROVIDER_STATUSES.has(payload.status) ||
    SECOND_SUBSCRIPTION_DISPOSITION_BY_STATUS[mapped.status] === "admits"
  ) {
    return;
  }
  logger.error(SECOND_LIVE_SUBSCRIPTION_EVENT, {
    organizationId: mapped.organizationId,
    liveSubscriptionId,
    incomingSubscriptionId: payload.id,
  });
};

const HOSTED_PROVIDER_STATUS_MAP = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "cancelled",
  unpaid: "past_due",
  incomplete: "past_due",
  incomplete_expired: "cancelled",
  paused: "paused",
} as const satisfies Record<PolarEntitlementStatus, UsageEntitlementStatus>;

class HostedProviderUnknownStatus extends TaggedError(
  "HostedProviderUnknownStatus",
)<{ message: string }> {}

const unknownProviderStatus = failureSink({
  event: "usage_provider.webhook.unknown_status",
  expected: [],
});

const mapHostedProviderStatus = (
  providerStatus: string,
  mode: DispatchMode,
) => {
  const parsed = v.safeParse(polarEntitlementStatusSchema, providerStatus);
  if (parsed.success) {
    return {
      providerStatus: parsed.output,
      status: HOSTED_PROVIDER_STATUS_MAP[parsed.output],
    };
  }
  if (mode !== "replay_dry_run") {
    observeFailure(
      new HostedProviderUnknownStatus({
        message: "Unrecognized provider status",
      }),
      {
        sink: unknownProviderStatus,
        ctx: {
          source: "usage_provider.webhook",
          step: "mapHostedProviderStatus",
        },
      },
    );
  }
  return null;
};

/**
 * Existence read under FOR KEY SHARE, the lock a referencing insert takes on
 * its parent row: once this returns true, the organization stays in place
 * until the transaction ends, so rows written for it keep a valid owner.
 */
const lockOrganizationIfExists = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<boolean> => {
  const rows = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
    .for("key share");
  return rows.length > 0;
};

type HostedEntitlementReconciliationParams = {
  tx: Transaction;
  payload: HostedUsageEntitlementPayload;
  eventId: string;
  reason: "provider_migration" | "unrecognized_status";
};

export const handleHostedEntitlementReconciliation = async ({
  tx,
  payload,
  eventId,
  reason,
}: HostedEntitlementReconciliationParams): Promise<DispatchOutcome> => {
  const existing =
    (await findEntitlementByHostedExternalId(tx, payload.id)) ??
    (await findEntitlementByOwner(tx, {
      type: "account",
      accountRef: payload.account_ref,
    }));
  const organizationId =
    existing?.organizationId ??
    parseAuthProviderId<"organization">(
      payload.metadata?.organization_id ?? "",
    );
  if (organizationId === null) {
    return {
      kind: "ignored",
      reason: "cannot resolve reconciliation audit owner",
    };
  }
  if (!existing && !(await lockOrganizationIfExists(tx, organizationId))) {
    return {
      kind: "ignored",
      reason: "reconciliation organization does not exist",
    };
  }
  await recordWebhookAuditEvent({
    tx,
    organizationId,
    eventId,
    action: AUDIT_ACTION.REVIEW,
    resourceType: existing
      ? AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT
      : AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: existing?.id ?? organizationId,
    changes: { reconciliation: { old: null, new: reason } },
  });
  return { kind: "ignored", reason };
};

const closedEntitlementStatuses: ReadonlySet<UsageEntitlementStatus> = new Set(
  CLOSED_USAGE_ENTITLEMENT_STATUSES,
);

const readHostedPeriod = (
  payload: HostedUsageEntitlementPayload,
  status: UsageEntitlementStatus,
) => {
  const closedPeriod = closedEntitlementStatuses.has(status);
  if (payload.current_period_end === null && !closedPeriod) {
    return null;
  }
  const start = new Date(payload.current_period_start);
  // Polar current_period_end is null on a suspended snapshot. Use
  // current_period_start as its equal bound to fence older activation
  // without inventing an end or allocating capacity.
  const end = new Date(
    payload.current_period_end ?? payload.current_period_start,
  );
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    (closedPeriod ? end < start : end <= start)
  ) {
    return null;
  }
  return closedPeriod
    ? { type: "closed" as const, start, end }
    : { type: "open" as const, start, end };
};

type ProviderAccessOverride =
  | { type: "deny" }
  | {
      type: "snapshot";
      status: PolarEntitlementStatus;
      cancelAtPeriodEnd: boolean;
    };

type ProviderAccessEventOptions = {
  override?: ProviderAccessOverride | undefined;
  status: PolarEntitlementStatus;
  payload: HostedUsageEntitlementPayload;
  periodEnd: Date;
  serviceActionsPerPeriod: number | null;
};

const providerAccessEvent = ({
  override,
  status,
  payload,
  periodEnd,
  serviceActionsPerPeriod,
}: ProviderAccessEventOptions): ConfiguredAccessEvent => {
  if (override?.type === "deny") {
    return { type: "deny" };
  }
  const eventStatus = override?.status ?? status;
  const cancelAtPeriodEnd =
    override?.cancelAtPeriodEnd ?? payload.cancel_at_period_end ?? false;
  switch (eventStatus) {
    case "active":
      return {
        type: "active",
        periodEndsAt: periodEnd,
        serviceActionsPerPeriod,
        cancelAtPeriodEnd,
      };
    case "past_due":
      return {
        type: "payment_retry",
        cancelAtPeriodEnd,
        occurredAt: parseOccurredAt(payload) ?? new Date(),
        retryWindowMs:
          env.PAYMENT_RETRY_WINDOW_MS ??
          panic("PAYMENT_RETRY_WINDOW_MS is unset"),
      };
    case "canceled":
      return {
        type: cancelAtPeriodEnd ? "cancel" : "deny",
      };
    case "trialing":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return { type: "deny" };
    default:
      eventStatus satisfies never;
      return panic("Unhandled provider access status");
  }
};

type ClearHostedCheckoutClaimOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  eventId: string;
};

/**
 * A subscription the provider reports as running completes the
 * organization's open checkout: clear the claim so the entitlement, not the
 * claim's expiry, decides the next checkout start.
 */
const clearHostedCheckoutClaim = async ({
  tx,
  organizationId,
  eventId,
}: ClearHostedCheckoutClaimOptions): Promise<void> => {
  const cleared = await tx
    .delete(hostedCheckoutClaims)
    .where(eq(hostedCheckoutClaims.organizationId, organizationId))
    .returning({ claimId: hostedCheckoutClaims.claimId });
  const claim = cleared.at(0);
  if (claim === undefined) {
    return;
  }
  await recordWebhookAuditEvent({
    tx,
    organizationId,
    action: AUDIT_ACTION.DELETE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    eventId,
    changes: {
      field: { old: null, new: "hostedCheckout" },
      claimId: { old: claim.claimId, new: null },
    },
  });
};

type HostedEntitlementUpsertParams = {
  mode?: DispatchMode;
  tx: Transaction;
  payload: HostedUsageEntitlementPayload;
  eventId: string;
  accessEvent?: ProviderAccessOverride;
};

type FirstEntitlementResolution =
  | {
      type: "created";
      id: SafeId<"usageEntitlement">;
      organizationId: SafeId<"organization">;
    }
  | { type: "existing"; row: ExistingEntitlement }
  | { type: "ignored"; reason: string };

type CreateFirstEntitlementOptions = {
  mode: DispatchMode;
  tx: Transaction;
  payload: HostedUsageEntitlementPayload;
  eventId: string;
  usagePolicyId: SafeId<"usagePolicy">;
  status: UsageEntitlementStatus;
  periodStart: Date;
  periodEnd: Date;
  occurredAt: Date | null;
};

const createFirstEntitlement = async ({
  mode,
  tx,
  payload,
  eventId,
  usagePolicyId,
  status,
  periodStart,
  periodEnd,
  occurredAt,
}: CreateFirstEntitlementOptions): Promise<FirstEntitlementResolution> => {
  const metadataOrganizationId = payload.metadata?.organization_id ?? null;
  const seats = payload.quantity ?? 1;
  // Truly fresh: no local mapping exists, so metadata is the only
  // ownership signal we have.
  if (metadataOrganizationId === null) {
    return { type: "ignored", reason: "missing metadata.organization_id" };
  }
  const organizationId = parseAuthProviderId<"organization">(
    metadataOrganizationId,
  );
  if (organizationId === null) {
    return { type: "ignored", reason: "invalid metadata.organization_id" };
  }
  if (!(await lockOrganizationIfExists(tx, organizationId))) {
    return { type: "ignored", reason: "organization does not exist" };
  }
  const inserted = await tx
    .insert(usageEntitlements)
    .values({
      organizationId,
      usagePolicyId,
      status,
      seats,
      hostedPeakSeats: seats,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      hostedAccountRef: payload.account_ref,
      hostedEntitlementExternalId: payload.id,
      hostedEntitlementCreatedAt:
        payload.created_at === undefined ? null : new Date(payload.created_at),
      cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
      hostedLastEventAt: occurredAt,
      source: "hosted",
    })
    .onConflictDoNothing()
    .returning({ id: usageEntitlements.id });

  const insertedId = inserted.at(0)?.id;
  if (insertedId) {
    await recordWebhookAuditEvent({
      tx,
      organizationId,
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
      resourceId: insertedId,
      eventId,
    });
    // Only the creator assigns the purchasing member; later designations
    // remain manager-managed and require validated organization membership.
    const purchaserUserId = await resolveSeatScopeUserId(
      tx,
      organizationId,
      payload.metadata?.seat_user_id,
    );
    if (purchaserUserId !== null) {
      await tx
        .insert(usageSeatAssignments)
        .values({ organizationId, userId: purchaserUserId })
        .onConflictDoNothing({
          target: [
            usageSeatAssignments.organizationId,
            usageSeatAssignments.userId,
          ],
        });
    }
    return { type: "created", id: insertedId, organizationId };
  }
  // Concurrent first deliveries collide on both organization and provider
  // identities. Let every unique index arbitrate, then re-read the committed
  // mappings under row locks before applying the normal ordering rules.
  const byProvider = await findEntitlementByHostedExternalId(tx, payload.id);
  const byAccount = await findEntitlementByOwner(tx, {
    type: "account",
    accountRef: payload.account_ref,
  });
  if (
    byProvider !== null &&
    byAccount !== null &&
    byProvider.id !== byAccount.id
  ) {
    signalSecondLiveSubscription({ mode, mapped: byAccount, payload });
    return {
      type: "ignored",
      reason: "hosted account reference already maps to another entitlement",
    };
  }
  const conflicting =
    byProvider ??
    byAccount ??
    (await findEntitlementByOwner(tx, {
      type: "organization",
      organizationId,
    }));
  if (conflicting === null) {
    panic("Conflicting usage entitlement disappeared");
  }
  return { type: "existing", row: conflicting };
};

export const handleHostedEntitlementUpsert = async ({
  mode = "live",
  tx,
  payload,
  eventId,
  accessEvent,
}: HostedEntitlementUpsertParams): Promise<DispatchOutcome> => {
  const mapped = mapHostedProviderStatus(payload.status, mode);
  if (mapped === null) {
    return await handleHostedEntitlementReconciliation({
      tx,
      payload,
      eventId,
      reason: "unrecognized_status",
    });
  }
  const status = mapped.status;
  const period = readHostedPeriod(payload, status);
  if (period === null) {
    return { kind: "ignored", reason: "invalid period dates" };
  }
  const { start: periodStart, end: periodEnd } = period;
  // metadata.organization_id (which we set at hosted setup creation) is
  // authoritative only before a local mapping exists. Once an entitlement is
  // mapped, the local row owns the org id, so a renewal/update that arrives
  // without metadata must still apply — requiring it up front would silently
  // drop the new period and skip the periodic allocation.
  if (payload.created_at === undefined && mode !== "replay_dry_run") {
    logger.warn("usage_provider.webhook.missing_generation", { eventId });
  }
  const metadataOrganizationId = payload.metadata?.organization_id ?? null;

  const policy = await resolvePolicyByHostedPolicyRef(
    tx,
    payload.policy_ref,
    "subscription",
  );
  if (!policy) {
    return {
      kind: "ignored",
      reason: `no subscription usage_policy matches hosted policy reference ${payload.policy_ref}`,
    };
  }

  const seats = payload.quantity ?? 1;
  const occurredAt = parseOccurredAt(payload);
  const existingByProvider = await findEntitlementByHostedExternalId(
    tx,
    payload.id,
  );

  let entitlementId: SafeId<"usageEntitlement">;
  // Ownership resolution: when a local entitlement row already
  // exists, the org id on THAT row is authoritative — the metadata
  // is a hint, not a source of truth (see /conventions-security
  // and the docstring at the top of this file). Only the fresh
  // insert path is allowed to trust metadata, because that's the
  // only signal we have before a local mapping exists.
  let ownerOrganizationId: SafeId<"organization">;
  // Pre-update row state, kept for the seat-increase delta below.
  // Null on the fresh-insert path: the periodic allocation already
  // covers every seat there.
  let previousRow: ExistingEntitlement | null = null;

  if (existingByProvider) {
    if (existingByProvider.source !== "hosted") {
      return {
        kind: "ignored",
        reason: "matching entitlement is manually managed",
      };
    }
    if (
      isStaleProviderEvent({
        mode,
        existing: existingByProvider,
        payload,
        occurredAt,
      })
    ) {
      return {
        kind: "ignored",
        reason: "stale provider event (does not supersede current state)",
      };
    }
    if (
      metadataOrganizationId !== null &&
      existingByProvider.organizationId !== metadataOrganizationId
    ) {
      // Metadata claims a different org than the row we already have
      // mapped to this provider entitlement. Either hosted setup
      // attached the wrong metadata or the event is otherwise
      // inconsistent. We must not silently move units between orgs.
      // Absent metadata is fine: the local row is authoritative.
      return {
        kind: "ignored",
        reason: "metadata organization_id mismatches local mapping",
      };
    }
    ownerOrganizationId = existingByProvider.organizationId;
    const existingByAccountRef = await findEntitlementByOwner(tx, {
      type: "account",
      accountRef: payload.account_ref,
    });
    if (
      existingByAccountRef &&
      existingByAccountRef.id !== existingByProvider.id
    ) {
      signalSecondLiveSubscription({
        mode,
        mapped: existingByAccountRef,
        payload,
      });
      return {
        kind: "ignored",
        reason: "hosted account reference already maps to another entitlement",
      };
    }
    previousRow = existingByProvider;
    await tx
      .update(usageEntitlements)
      .set({
        usagePolicyId: policy.id,
        status,
        seats,
        hostedPeakSeats: nextPeakSeats(existingByProvider, seats, periodStart),
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        hostedAccountRef: payload.account_ref,
        hostedEntitlementExternalId: payload.id,
        hostedEntitlementCreatedAt:
          payload.created_at === undefined
            ? existingByProvider.hostedEntitlementCreatedAt
            : new Date(payload.created_at),
        cancelAtPeriodEnd: cancellationFlagAtVersion({
          existing: existingByProvider,
          payload,
          occurredAt,
        }),
        ...lastEventPatch(existingByProvider, occurredAt),
      })
      .where(eq(usageEntitlements.id, existingByProvider.id));
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
      resourceId: existingByProvider.id,
      eventId,
      changes: { provider_event: { old: null, new: eventId } },
    });
    entitlementId = existingByProvider.id;
  } else {
    // Fresh entitlement. Refuse if the org already has a manual
    // entitlement; an operator must resolve the conflict explicitly.
    const existingByAccountRef = await findEntitlementByOwner(tx, {
      type: "account",
      accountRef: payload.account_ref,
    });
    const resolved =
      existingByAccountRef !== null
        ? ({ type: "existing", row: existingByAccountRef } as const)
        : await createFirstEntitlement({
            mode,
            tx,
            payload,
            eventId,
            usagePolicyId: policy.id,
            status,
            periodStart,
            periodEnd,
            occurredAt,
          });
    switch (resolved.type) {
      case "ignored":
        return { kind: "ignored", reason: resolved.reason };
      case "created": {
        entitlementId = resolved.id;
        ownerOrganizationId = resolved.organizationId;
        break;
      }
      case "existing": {
        const existing = resolved.row;
        if (existing.source === "manual") {
          return {
            kind: "ignored",
            reason: "org has manual entitlement; refuse hosted overwrite",
          };
        }
        if (
          metadataOrganizationId !== null &&
          existing.organizationId !== metadataOrganizationId
        ) {
          return {
            kind: "ignored",
            reason: "metadata organization_id mismatches local account mapping",
          };
        }
        const replacesExternalId =
          payload.id !== existing.hostedEntitlementExternalId;
        if (
          replacesExternalId &&
          TERMINAL_PROVIDER_STATUSES.has(payload.status)
        ) {
          if (mode !== "replay_dry_run") {
            logger.info("usage_provider.webhook.superseded", {
              entityId: existing.id,
              eventId,
            });
          }
          return {
            kind: "ignored",
            reason: "terminal event for a superseded external entitlement",
          };
        }
        signalSecondLiveSubscription({ mode, mapped: existing, payload });
        if (
          isStaleProviderEvent({
            mode,
            existing,
            payload,
            occurredAt,
          })
        ) {
          return {
            kind: "ignored",
            reason: "stale provider event (does not supersede current state)",
          };
        }
        const previousCreatedAt = replacesExternalId
          ? null
          : existing.hostedEntitlementCreatedAt;
        ownerOrganizationId = existing.organizationId;
        previousRow = existing;
        await tx
          .update(usageEntitlements)
          .set({
            usagePolicyId: policy.id,
            status,
            seats,
            hostedPeakSeats: nextPeakSeats(existing, seats, periodStart),
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            hostedAccountRef: payload.account_ref,
            hostedEntitlementExternalId: payload.id,
            hostedEntitlementCreatedAt:
              payload.created_at === undefined
                ? previousCreatedAt
                : new Date(payload.created_at),
            cancelAtPeriodEnd: replacesExternalId
              ? (payload.cancel_at_period_end ?? false)
              : cancellationFlagAtVersion({
                  existing,
                  payload,
                  occurredAt,
                }),
            // A replacement owns its own event clock, even when the previous
            // generation was modified more recently.
            ...(replacesExternalId
              ? { hostedLastEventAt: occurredAt }
              : lastEventPatch(existing, occurredAt)),
          })
          .where(eq(usageEntitlements.id, existing.id));
        await recordWebhookAuditEvent({
          tx,
          organizationId: ownerOrganizationId,
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
          resourceId: existing.id,
          eventId,
          changes: { provider_event: { old: null, new: eventId } },
        });
        entitlementId = existing.id;
        break;
      }
      default:
        resolved satisfies never;
        panic("Unhandled entitlement resolution");
    }
  }

  // A terminated subscription leaves any newer open checkout in place.
  if (status !== "cancelled") {
    await clearHostedCheckoutClaim({
      tx,
      organizationId: ownerOrganizationId,
      eventId,
    });
  }

  // Capacity may have shrunk: drop designations beyond the recorded
  // count, keeping the earliest-designated members, under the same
  // per-organization lock the designation endpoints take so a racing
  // designation cannot slip past the new bound.
  await lockAssignmentCapacity(tx, ownerOrganizationId);
  const trimmedAssignments = await trimAssignmentsToCapacity(
    tx,
    ownerOrganizationId,
    seats,
  );
  if (trimmedAssignments > 0) {
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: ownerOrganizationId,
      eventId,
      changes: {
        field: { old: null, new: "usageAssignment" },
        removed: { old: null, new: trimmedAssignments },
        seats: { old: null, new: seats },
      },
    });
  }

  if (isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS")) {
    await applyConfiguredAccessEvent({
      tx,
      organizationId: ownerOrganizationId,
      previousSource: previousRow,
      mapping:
        previousRow !== null &&
        previousRow.hostedEntitlementExternalId !== payload.id
          ? "replacement"
          : "current",
      event: providerAccessEvent({
        override: accessEvent,
        status: mapped.providerStatus,
        payload,
        periodEnd,
        serviceActionsPerPeriod: policy.serviceActionsPerPeriod,
      }),
    });
  }

  if (period.type === "closed") {
    return { kind: "applied", entitlementId };
  }

  // Allocate the period's usage units. Idempotent per entitlement period,
  // not per webhook event id: providers may emit multiple updates inside
  // a single period (status flips, seat changes), each with a
  // fresh event id, and keying idempotency on the event id would
  // mint a second periodic allocation on every one. Keying on the
  // local entitlement id + period start collapses all of those
  // re-emits into a single allocation for the period, even if the
  // hosted external entitlement reference changes during reconfiguration.
  const periodicAllocationSourceRef = `${entitlementId}:${periodStart.toISOString()}`;
  const allocation = await allocateUsage({
    tx,
    organizationId: ownerOrganizationId,
    units: policy.monthlyUsageUnits * seats,
    reason: "periodic",
    sourceType: "hosted_entitlement",
    sourceRef: periodicAllocationSourceRef,
    period: { start: periodStart, end: periodEnd },
  });
  if (allocation.status === "allocated") {
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
      resourceId: allocation.id,
      eventId,
      changes: {
        units: { old: null, new: policy.monthlyUsageUnits * seats },
        reason: { old: null, new: "periodic" },
      },
    });
  }

  // A mid-period seat increase grants its unit delta immediately,
  // pro-rated by the remaining period fraction — the periodic
  // allocation above is idempotent per period and will not re-fire.
  // The delta keys on the new seat count, so a re-delivered event
  // dedupes, and because it is measured against the period's PEAK,
  // cycling seats down and back up cannot mint the same capacity
  // twice. Seat decreases grant nothing and never claw back units;
  // the lower count simply shapes the next renewal's allocation.
  if (previousRow !== null) {
    const samePeriod =
      previousRow.currentPeriodStart.getTime() === periodStart.getTime();
    const previousPeak = peakSeatsOf(previousRow);
    if (samePeriod && seats > previousPeak) {
      const asOf = occurredAt ?? new Date();
      const periodMs = periodEnd.getTime() - periodStart.getTime();
      const remainingMs = periodEnd.getTime() - asOf.getTime();
      const remainingFraction = Math.min(
        Math.max(remainingMs / periodMs, 0),
        1,
      );
      const deltaUnits = Math.floor(
        policy.monthlyUsageUnits * (seats - previousPeak) * remainingFraction,
      );
      const deltaAllocation = await allocateUsage({
        tx,
        organizationId: ownerOrganizationId,
        units: deltaUnits,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: `${periodicAllocationSourceRef}:seats:${seats}`,
        period: { start: periodStart, end: periodEnd },
      });
      if (deltaAllocation.status === "allocated") {
        await recordWebhookAuditEvent({
          tx,
          organizationId: ownerOrganizationId,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
          resourceId: deltaAllocation.id,
          eventId,
          changes: {
            units: { old: null, new: deltaUnits },
            reason: { old: null, new: "periodic" },
            seats: { old: previousPeak, new: seats },
          },
        });
      }
    }
  }

  return { kind: "applied", entitlementId };
};

type UsageEntitlementStatusUpdateParams = {
  mode?: DispatchMode;
  tx: Transaction;
  payload: HostedUsageEntitlementPayload;
  eventId: string;
  /**
   * Distinguishes "scheduled to end at period end" (canceled)
   * from "terminated now" (revoked). The provider emits both with
   * different lifecycle semantics:
   *  - canceled: keep `status = "active"` (or whatever the provider
   *    reports) and flip `cancel_at_period_end = true`. The user
   *    keeps access until `current_period_end`.
   *  - revoked: set `status = "cancelled"` and
   *    `cancel_at_period_end = false`. Access is gone immediately.
   */
  eventKind: "canceled" | "revoked";
};

export const handleUsageEntitlementStatusChange = async ({
  mode = "live",
  tx,
  payload,
  eventId,
  eventKind,
}: UsageEntitlementStatusUpdateParams): Promise<DispatchOutcome> => {
  // Revocation denies access independently of the reported snapshot status.
  const mapped = mapHostedProviderStatus(payload.status, mode);
  const mappedStatus =
    eventKind === "revoked" ? "cancelled" : (mapped?.status ?? null);
  if (mappedStatus === null) {
    return await handleHostedEntitlementReconciliation({
      tx,
      payload,
      eventId,
      reason: "unrecognized_status",
    });
  }
  const transition = {
    canceled: {
      status: mappedStatus,
      providerStatus: payload.status,
      cancelAtPeriodEnd: true,
    },
    revoked: {
      status: "cancelled",
      providerStatus: "canceled",
      cancelAtPeriodEnd: false,
    },
  } as const satisfies Record<
    UsageEntitlementStatusUpdateParams["eventKind"],
    {
      status: UsageEntitlementStatus;
      providerStatus: string;
      cancelAtPeriodEnd: boolean;
    }
  >;
  const { providerStatus, ...update } = transition[eventKind];
  let existing = await findEntitlementByHostedExternalId(tx, payload.id);
  if (!existing) {
    const current = await findEntitlementByOwner(tx, {
      type: "account",
      accountRef: payload.account_ref,
    });
    if (current && current.hostedEntitlementExternalId !== payload.id) {
      if (mode !== "replay_dry_run") {
        logger.info("usage_provider.webhook.superseded", {
          entityId: current.id,
          eventId,
        });
      }
      return {
        kind: "ignored",
        reason: "terminal event for a superseded external entitlement",
      };
    }
    if (!current) {
      return await handleHostedEntitlementUpsert({
        mode,
        tx,
        eventId,
        accessEvent:
          eventKind === "revoked"
            ? { type: "deny" }
            : {
                type: "snapshot",
                status:
                  mapped?.providerStatus ??
                  panic("Accepted cancellation status is missing"),
                cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
              },
        payload: {
          ...payload,
          status: providerStatus,
          cancel_at_period_end: eventKind === "canceled",
        },
      });
    }
    existing = current;
  }
  if (payload.created_at === undefined && mode !== "replay_dry_run") {
    logger.warn("usage_provider.webhook.missing_generation", { eventId });
  }
  if (existing.source !== "hosted") {
    return {
      kind: "ignored",
      reason: "entitlement is manually managed",
    };
  }
  const occurredAt = parseOccurredAt(payload);
  const orderingPayload = {
    ...payload,
    status: providerStatus,
    cancel_at_period_end: eventKind === "canceled",
  };
  if (
    isStaleProviderEvent({
      mode,
      existing,
      payload: orderingPayload,
      occurredAt,
    })
  ) {
    return {
      kind: "ignored",
      reason: "stale provider event (does not supersede current state)",
    };
  }
  await tx
    .update(usageEntitlements)
    .set({
      ...update,
      ...lastEventPatch(existing, occurredAt),
      hostedEntitlementCreatedAt:
        payload.created_at === undefined
          ? existing.hostedEntitlementCreatedAt
          : new Date(payload.created_at),
    })
    .where(eq(usageEntitlements.id, existing.id));
  await recordWebhookAuditEvent({
    tx,
    organizationId: existing.organizationId,
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
    resourceId: existing.id,
    eventId,
    changes: {
      eventKind: { old: null, new: eventKind },
      cancelAtPeriodEnd: { old: null, new: update.cancelAtPeriodEnd },
      status: { old: null, new: update.status },
    },
  });
  if (isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS")) {
    const policy = await tx
      .select({
        serviceActionsPerPeriod: usagePolicies.serviceActionsPerPeriod,
        currentPeriodEnd: usageEntitlements.currentPeriodEnd,
      })
      .from(usageEntitlements)
      .innerJoin(
        usagePolicies,
        eq(usagePolicies.id, usageEntitlements.usagePolicyId),
      )
      .where(eq(usageEntitlements.organizationId, existing.organizationId))
      .limit(1)
      .then(
        (rows) => rows.at(0) ?? panic("Configured access policy is missing"),
      );
    await applyConfiguredAccessEvent({
      tx,
      organizationId: existing.organizationId,
      previousSource: existing,
      mapping: "current",
      event:
        eventKind === "revoked"
          ? { type: "deny" }
          : providerAccessEvent({
              status:
                mapped?.providerStatus ??
                panic("Accepted cancellation status is missing"),
              payload,
              periodEnd: policy.currentPeriodEnd,
              serviceActionsPerPeriod: policy.serviceActionsPerPeriod,
            }),
    });
  }
  return { kind: "applied", entitlementId: existing.id };
};

type HostedAllocationParams = {
  tx: Transaction;
  payload: HostedUsageAllocationPayload;
  eventId: string;
};

export const handleHostedAllocation = async ({
  tx,
  payload,
  eventId,
}: HostedAllocationParams): Promise<DispatchOutcome> => {
  if (payload.allocation_reason !== "addon") {
    return {
      kind: "ignored",
      reason: `allocation_reason ${payload.allocation_reason ?? "missing"} is not an addon allocation`,
    };
  }

  // Addon allocation events must carry the organization mapping we
  // attached at hosted setup creation. Anything missing falls through
  // to ignored; we never invent ownership from account_ref.
  const organizationIdRaw = payload.metadata?.organization_id;
  if (!organizationIdRaw) {
    return { kind: "ignored", reason: "missing metadata.organization_id" };
  }
  const organizationId = parseAuthProviderId<"organization">(organizationIdRaw);
  if (organizationId === null) {
    return { kind: "ignored", reason: "invalid metadata.organization_id" };
  }

  const policy = await resolvePolicyByHostedPolicyRef(
    tx,
    payload.policy_ref,
    "addon",
  );
  if (!policy) {
    return {
      kind: "ignored",
      reason: `no add-on usage_policy matches hosted policy reference ${payload.policy_ref}`,
    };
  }

  // Add-ons attach to the active entitlement period.
  // Without an entitlement the org has no period to attribute the
  // allocation to; surface as ignored rather than synthesise one.
  const existing = await findEntitlementByOwner(tx, {
    type: "account",
    accountRef: payload.account_ref,
  });
  if (!existing) {
    return {
      kind: "ignored",
      reason: "add-on has no associated entitlement",
    };
  }
  // Ownership: the metadata-supplied org id must match the locally
  // mapped entitlement's org. A mismatch means hosted setup metadata
  // or event mapping is inconsistent; in either case we
  // refuse the allocation rather than silently moving units.
  if (existing.organizationId !== organizationId) {
    return {
      kind: "ignored",
      reason: "metadata organization_id mismatches local mapping",
    };
  }

  const periodRows = await tx
    .select({
      currentPeriodStart: usageEntitlements.currentPeriodStart,
      currentPeriodEnd: usageEntitlements.currentPeriodEnd,
    })
    .from(usageEntitlements)
    .where(eq(usageEntitlements.id, existing.id))
    .limit(1);
  const period = periodRows.at(0);
  if (!period) {
    return { kind: "ignored", reason: "entitlement row vanished" };
  }

  // metadata.seat_user_id is the Stella user.id of the seat that
  // initiated hosted setup; recorded on the ledger row so future
  // per-seat reporting can attribute the allocation. We
  // verify the user is actually a member of the org before
  // writing it; a stale or wrong value (e.g. user left the org
  // between hosted setup and webhook delivery) falls back to org pool
  // attribution rather than poisoning the audit trail.
  const seatScopeUserId = await resolveSeatScopeUserId(
    tx,
    organizationId,
    payload.metadata?.seat_user_id,
  );

  const allocationResult = await allocateUsage({
    tx,
    organizationId,
    units: policy.monthlyUsageUnits,
    reason: "addon",
    sourceType: "hosted_allocation",
    sourceRef: eventId,
    seatScopeUserId,
    period: {
      start: period.currentPeriodStart,
      end: period.currentPeriodEnd,
    },
  });

  if (allocationResult.status === "duplicate") {
    return { kind: "duplicate_allocation" };
  }
  if (allocationResult.status === "skipped") {
    return { kind: "ignored", reason: "policy grants zero add-on units" };
  }

  await recordWebhookAuditEvent({
    tx,
    organizationId,
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
    resourceId: allocationResult.id,
    eventId,
    changes: {
      units: { old: null, new: policy.monthlyUsageUnits },
      reason: { old: null, new: "addon" },
      seatScopeUserId: { old: null, new: seatScopeUserId },
    },
  });

  return { kind: "applied", entitlementId: existing.id };
};

type DispatchEventOptions = {
  mode: DispatchMode;
  tx: Transaction;
  event: HostedUsageWebhookEvent;
  eventId: string;
};

export const dispatchEvent = async ({
  mode,
  tx,
  event,
  eventId,
}: DispatchEventOptions): Promise<DispatchOutcome> => {
  switch (event.type) {
    case "entitlement.created":
    case "entitlement.updated":
    case "entitlement.active":
      return await handleHostedEntitlementUpsert({
        mode,
        tx,
        payload: event.data,
        eventId,
      });
    case "entitlement.reconciliation":
      return await handleHostedEntitlementReconciliation({
        tx,
        payload: event.data,
        eventId,
        reason: "provider_migration",
      });
    case "entitlement.paused":
      // A pause can introduce a replacement generation before its creation
      // arrives; the upsert's generation clock must retain that denial.
      return await handleHostedEntitlementUpsert({
        mode,
        tx,
        payload: {
          ...event.data,
          status: "paused",
          cancel_at_period_end: false,
        },
        eventId,
      });
    case "entitlement.canceled":
      return await handleUsageEntitlementStatusChange({
        mode,
        tx,
        payload: event.data,
        eventId,
        eventKind: "canceled",
      });
    case "entitlement.revoked":
      return await handleUsageEntitlementStatusChange({
        mode,
        tx,
        payload: event.data,
        eventId,
        eventKind: "revoked",
      });
    case "allocation.created":
      return await handleHostedAllocation({
        tx,
        payload: event.data,
        eventId,
      });
    default: {
      event satisfies never;
      return panic(`Unhandled event: ${String(event)}`);
    }
  }
};

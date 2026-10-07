import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { HOSTED_CHECKOUT_REFUSAL_CODE } from "@stll/api-contract/hosted-checkout";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  hostedCheckoutClaims,
  USAGE_ENTITLEMENT_STATUSES,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createHostedSetupSession,
  HOSTED_PROVIDER_REQUEST_TIMEOUT_MS,
} from "@/api/lib/hosted-usage-provider/client";
import { getApiCredentials } from "@/api/lib/hosted-usage-provider/config";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  checkMemberCapacityChange,
  memberCapacityOf,
} from "@/api/lib/usage/member-capacity";
import { isEntitlementConsumableAt } from "@/api/lib/usage/usage-ledger";

/** Create a hosted setup session for an active usage policy. */

const createHostedSetupBodySchema = t.Object({
  usagePolicyId: tSafeId("usagePolicy"),
  // Seat count for seat-based subscription checkout. Bounded well below
  // any legitimate organisation size; larger arrangements go through an
  // operator, not self-service.
  seats: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "hosted_billing" },
  body: createHostedSetupBodySchema,
} satisfies HandlerConfig;

const hostedExternalAccountRef = (
  organizationId: SafeId<"organization">,
): string => `stella_org_${organizationId}`;

// Covers the provider call; a created session's own expiry replaces it.
const HOSTED_CHECKOUT_CLAIM_TTL_SECONDS = 60 * 60;

const CHECKOUT_CLAIM_SETTLE_FAILED = failureSink({
  event: "usage.hosted_checkout.claim_settle_failed",
  expected: [],
});

// A matching start waits this long for a claim still creating its session:
// the provider call's own timeout plus the write that records the session.
const HOSTED_CHECKOUT_AWAIT_MS = HOSTED_PROVIDER_REQUEST_TIMEOUT_MS + 2000;
const HOSTED_CHECKOUT_AWAIT_POLL_MS = 200;
const HOSTED_CHECKOUT_AUDIT_FIELD = "hostedCheckout";
// A paid subscription (active, past_due, paused) is changed through hosted
// management, not bought again; a trial or an ended subscription upgrades
// through checkout.
const CHECKOUT_DISPOSITION_BY_STATUS = {
  trialing: "admits",
  active: "blocks",
  past_due: "blocks",
  cancelled: "admits",
  paused: "blocks",
} as const satisfies Record<UsageEntitlementStatus, "admits" | "blocks">;
const CHECKOUT_BLOCKING_STATUSES = USAGE_ENTITLEMENT_STATUSES.filter(
  (status) => CHECKOUT_DISPOSITION_BY_STATUS[status] === "blocks",
);

type HostedCheckoutRequest = {
  usagePolicyId: SafeId<"usagePolicy">;
  seats: number | null;
};

type HostedCheckoutSession = { hostedSessionId: string; url: string };

type RecordedSessionColumns = {
  hostedSessionId: string | null;
  hostedCheckoutUrl: string | null;
};

/** The created session a claim records, or null while it is being created. */
const recordedSession = ({
  hostedSessionId,
  hostedCheckoutUrl,
}: RecordedSessionColumns): HostedCheckoutSession | null => {
  if (hostedCheckoutUrl === null) {
    return null;
  }
  // hosted_checkout_claims_url_has_session_check guarantees the pair.
  if (hostedSessionId === null) {
    return panic("Hosted checkout claim records a URL without a session");
  }
  return { hostedSessionId, url: hostedCheckoutUrl };
};

type ClaimHostedCheckoutOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  request: HostedCheckoutRequest;
  recordAuditEvent: AuditRecorder;
};

/**
 * Claim the organization's single open subscription checkout in one
 * statement, so concurrent starts resolve to exactly one claimant. A start
 * takes the claim over when it expired, or when it records a session created
 * for a different policy or seat count; that session is left to expire, as
 * the provider client has no call to close one. Otherwise the open claim
 * decides: its session is reused for the same request, a matching session
 * still being created is awaited, and anything else refuses the start.
 */
const claimHostedCheckout = async ({
  tx,
  organizationId,
  request,
  recordAuditEvent,
}: ClaimHostedCheckoutOptions) => {
  const claimId = createSafeId<"hostedCheckoutClaim">();
  const claimed = await tx
    .insert(hostedCheckoutClaims)
    .values({
      organizationId,
      claimId,
      usagePolicyId: request.usagePolicyId,
      seats: request.seats,
      expiresAt: sql`now() + make_interval(secs => ${HOSTED_CHECKOUT_CLAIM_TTL_SECONDS})`,
    })
    .onConflictDoUpdate({
      target: hostedCheckoutClaims.organizationId,
      set: {
        claimId,
        hostedSessionId: null,
        hostedCheckoutUrl: null,
        usagePolicyId: sql`excluded.usage_policy_id`,
        seats: sql`excluded.seats`,
        expiresAt: sql`excluded.expires_at`,
        createdAt: sql`now()`,
      },
      setWhere: sql`${hostedCheckoutClaims.expiresAt} <= now() OR (${hostedCheckoutClaims.hostedCheckoutUrl} IS NOT NULL AND (${hostedCheckoutClaims.usagePolicyId} IS DISTINCT FROM excluded.usage_policy_id OR ${hostedCheckoutClaims.seats} IS DISTINCT FROM excluded.seats))`,
    })
    .returning({ claimId: hostedCheckoutClaims.claimId });
  if (claimed.at(0) === undefined) {
    // ON CONFLICT locked the open claim, so this read sees its final state.
    const open = (
      await tx
        .select({
          claimId: hostedCheckoutClaims.claimId,
          hostedSessionId: hostedCheckoutClaims.hostedSessionId,
          hostedCheckoutUrl: hostedCheckoutClaims.hostedCheckoutUrl,
          usagePolicyId: hostedCheckoutClaims.usagePolicyId,
          seats: hostedCheckoutClaims.seats,
          creating: sql<boolean>`${hostedCheckoutClaims.createdAt} > now() - make_interval(secs => ${HOSTED_CHECKOUT_AWAIT_MS / 1000})`,
        })
        .from(hostedCheckoutClaims)
        .where(eq(hostedCheckoutClaims.organizationId, organizationId))
        .limit(1)
    ).at(0);
    if (open === undefined) {
      return panic("A conflicting hosted checkout claim cannot be read");
    }
    const session = recordedSession(open);
    if (session !== null) {
      return { kind: "reuse" as const, session };
    }
    const sameRequest =
      open.usagePolicyId === request.usagePolicyId &&
      open.seats === request.seats;
    if (sameRequest && open.creating) {
      return { kind: "await" as const, claimId: open.claimId };
    }
    return { kind: "checkout_open" as const };
  }
  // The subscription event that completes a checkout clears its claim in the
  // transaction that records the entitlement. Re-read the entitlement in a
  // statement that starts after this claim, so a subscription committed since
  // the read above refuses the start.
  const live = await tx
    .select({ status: usageEntitlements.status })
    .from(usageEntitlements)
    .where(
      and(
        eq(usageEntitlements.organizationId, organizationId),
        inArray(usageEntitlements.status, CHECKOUT_BLOCKING_STATUSES),
      ),
    )
    .limit(1);
  if (live.at(0) !== undefined) {
    await tx
      .delete(hostedCheckoutClaims)
      .where(
        and(
          eq(hostedCheckoutClaims.organizationId, organizationId),
          eq(hostedCheckoutClaims.claimId, claimId),
        ),
      );
    return { kind: "subscription_live" as const };
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    metadata: { field: HOSTED_CHECKOUT_AUDIT_FIELD, claimId },
  });
  return { kind: "claimed" as const, claimId };
};

type SettleHostedCheckoutClaimOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  claimId: SafeId<"hostedCheckoutClaim">;
  recordAuditEvent: AuditRecorder;
  /** The created provider session, or null to release the claim. */
  session: { id: string; url: string; expiresAt: Date | null } | null;
};

/**
 * Record the created provider session on the claim, or release the claim
 * when no session was created. Either write is a no-op once the claim was
 * cleared or taken over.
 */
const settleHostedCheckoutClaim = async ({
  safeDb,
  organizationId,
  claimId,
  recordAuditEvent,
  session,
}: SettleHostedCheckoutClaimOptions) =>
  await safeDb(async (tx) => {
    const ownClaim = and(
      eq(hostedCheckoutClaims.organizationId, organizationId),
      eq(hostedCheckoutClaims.claimId, claimId),
    );
    const settled =
      session === null
        ? await tx
            .delete(hostedCheckoutClaims)
            .where(ownClaim)
            .returning({ claimId: hostedCheckoutClaims.claimId })
        : await tx
            .update(hostedCheckoutClaims)
            .set({
              hostedSessionId: session.id,
              hostedCheckoutUrl: session.url,
              expiresAt:
                session.expiresAt ?? sql`${hostedCheckoutClaims.expiresAt}`,
            })
            .where(ownClaim)
            .returning({ claimId: hostedCheckoutClaims.claimId });
    if (settled.at(0) === undefined) {
      return;
    }
    await recordAuditEvent(tx, {
      action: session === null ? AUDIT_ACTION.DELETE : AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      metadata: { field: HOSTED_CHECKOUT_AUDIT_FIELD, claimId },
    });
  });

type AwaitHostedCheckoutSessionOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  claimId: SafeId<"hostedCheckoutClaim">;
  /** `performance.now()` after which the start stops waiting. */
  deadline: number;
};

type AwaitHostedCheckoutSessionResult = Result<
  | { kind: "reuse"; session: HostedCheckoutSession }
  | { kind: "released" }
  | { kind: "checkout_open" },
  SafeDbError
>;

/**
 * Wait for a concurrent matching start to record its session, one read per
 * interval. Ends with the session, with `released` when that start created
 * none, or with `checkout_open` when it is still creating one at the deadline.
 */
const awaitHostedCheckoutSession = async ({
  safeDb,
  organizationId,
  claimId,
  deadline,
}: AwaitHostedCheckoutSessionOptions): Promise<AwaitHostedCheckoutSessionResult> => {
  if (performance.now() >= deadline) {
    return Result.ok({ kind: "checkout_open" });
  }
  await Bun.sleep(HOSTED_CHECKOUT_AWAIT_POLL_MS);
  const read = await safeDb(async (tx) =>
    (
      await tx
        .select({
          hostedSessionId: hostedCheckoutClaims.hostedSessionId,
          hostedCheckoutUrl: hostedCheckoutClaims.hostedCheckoutUrl,
        })
        .from(hostedCheckoutClaims)
        .where(
          and(
            eq(hostedCheckoutClaims.organizationId, organizationId),
            eq(hostedCheckoutClaims.claimId, claimId),
          ),
        )
        .limit(1)
    ).at(0),
  );
  if (Result.isError(read)) {
    return read;
  }
  if (read.value === undefined) {
    return Result.ok({ kind: "released" });
  }
  const session = recordedSession(read.value);
  if (session !== null) {
    return Result.ok({ kind: "reuse", session });
  }
  return await awaitHostedCheckoutSession({
    safeDb,
    organizationId,
    claimId,
    deadline,
  });
};

type PrepareCheckoutStartOptions = {
  tx: Transaction;
  body: typeof createHostedSetupBodySchema.static;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
};

/** Validate a checkout start and, for a subscription, claim the checkout. */
const prepareCheckoutStart = async ({
  tx,
  body,
  organizationId,
  recordAuditEvent,
}: PrepareCheckoutStartOptions) => {
  const policyRows = await tx
    .select({
      id: usagePolicies.id,
      active: usagePolicies.active,
      kind: usagePolicies.kind,
      visibility: usagePolicies.visibility,
      hostedPolicyRef: usagePolicies.hostedPolicyRef,
      priceBasis: usagePolicies.priceBasis,
      maxMembers: usagePolicies.maxMembers,
    })
    .from(usagePolicies)
    .where(eq(usagePolicies.id, body.usagePolicyId))
    .limit(1);
  const policy = policyRows.at(0);
  if (!policy) {
    return { kind: "policy_not_found" as const };
  }
  // Retired offers are hidden by the seeder, not deleted; a client
  // holding a stale policy id must not be able to start checkout
  // for something the catalog no longer advertises.
  if (
    !policy.active ||
    !policy.hostedPolicyRef ||
    policy.visibility !== "public"
  ) {
    return { kind: "policy_not_hosted" as const };
  }

  const entitlementRows = await tx
    .select({
      source: usageEntitlements.source,
      hostedAccountRef: usageEntitlements.hostedAccountRef,
      status: usageEntitlements.status,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
      currentPeriodEnd: usageEntitlements.currentPeriodEnd,
    })
    .from(usageEntitlements)
    .where(and(eq(usageEntitlements.organizationId, organizationId)))
    .limit(1);
  const entitlement = entitlementRows.at(0);
  if (entitlement?.source === "manual") {
    return { kind: "manual_entitlement_present" as const };
  }
  // An add-on allocation is resolved against the buyer's hosted
  // entitlement's CURRENT period at webhook time; without a mapped
  // hosted account the paid allocation would be unattributable,
  // and against a cancelled/paused/expired entitlement it would
  // land in a period the organisation cannot consume. Refuse up
  // front rather than accepting money we cannot apply.
  if (policy.kind === "addon") {
    const consumable =
      entitlement !== undefined &&
      entitlement.hostedAccountRef !== null &&
      isEntitlementConsumableAt(entitlement);
    if (!consumable) {
      return { kind: "addon_requires_subscription" as const };
    }
  }

  // One provider subscription per organization: a further one is
  // changed or cancelled through hosted management, not bought again.
  if (
    policy.kind === "subscription" &&
    entitlement !== undefined &&
    CHECKOUT_DISPOSITION_BY_STATUS[entitlement.status] === "blocks"
  ) {
    return { kind: "subscription_live" as const };
  }

  // Seat counts only make sense on seat-priced subscription
  // checkout. On anything else — a pack, or a flat-priced plan —
  // a quantity signals a confused client, and forwarding it to
  // the provider could inflate the webhook's granted units.
  if (
    body.seats !== undefined &&
    (policy.kind !== "subscription" || policy.priceBasis !== "per_seat")
  ) {
    return { kind: "seats_on_non_subscription" as const };
  }

  // A subscription replaces the organization's member capacity: one
  // that would leave more members than it admits is refused rather
  // than removing anyone. The provider applies a missing quantity as
  // one seat.
  if (policy.kind === "subscription") {
    const change = await checkMemberCapacityChange(tx, {
      organizationId,
      nextCapacity: memberCapacityOf({
        maxMembers: policy.maxMembers,
        priceBasis: policy.priceBasis,
        seats: body.seats ?? 1,
      }),
    });
    if (Result.isError(change)) {
      return {
        kind: "member_capacity_exceeded" as const,
        error: change.error,
      };
    }
  }

  // Add-on packs attach to the existing subscription and take no claim.
  if (policy.kind === "addon") {
    return {
      kind: "ok" as const,
      policyRef: policy.hostedPolicyRef,
      accountRef: entitlement?.hostedAccountRef ?? null,
      claimId: null,
    };
  }
  const claim = await claimHostedCheckout({
    tx,
    organizationId,
    request: { usagePolicyId: body.usagePolicyId, seats: body.seats ?? null },
    recordAuditEvent,
  });
  if (claim.kind !== "claimed") {
    return claim;
  }
  return {
    kind: "ok" as const,
    policyRef: policy.hostedPolicyRef,
    accountRef: entitlement?.hostedAccountRef ?? null,
    claimId: claim.claimId,
  };
};

type CheckoutRefusal = Exclude<
  Awaited<ReturnType<typeof prepareCheckoutStart>>,
  { kind: "ok" | "reuse" | "await" }
>;

const checkoutRefusalError = (refusal: CheckoutRefusal) => {
  switch (refusal.kind) {
    case "policy_not_found":
      return new HandlerError({
        status: 404,
        message: "Usage policy not found",
      });
    case "policy_not_hosted":
      return new HandlerError({
        status: 400,
        message: "Usage policy is not available through hosted self-service",
      });
    case "manual_entitlement_present":
      return new HandlerError({
        status: 409,
        message:
          "This organisation has a manually managed usage entitlement. Contact an operator to switch management.",
      });
    case "addon_requires_subscription":
      return new HandlerError({
        status: 409,
        message:
          "An active subscription is required before purchasing add-on packs",
      });
    case "subscription_live":
      return new HandlerError({
        code: HOSTED_CHECKOUT_REFUSAL_CODE.subscriptionLive,
        status: 409,
        message:
          "This organization already has a subscription. Change it through hosted usage management.",
      });
    case "checkout_open":
      return new HandlerError({
        code: HOSTED_CHECKOUT_REFUSAL_CODE.checkoutOpen,
        status: 409,
        message:
          "A checkout for this organization is already open. Complete it, or start a new one after it expires.",
      });
    case "member_capacity_exceeded":
      return refusal.error;
    case "seats_on_non_subscription":
      return new HandlerError({
        status: 400,
        message: "Seat counts apply to subscription policies only",
      });
    default:
      refusal satisfies never;
      return panic("Unhandled hosted checkout refusal");
  }
};

/** The provider created no session, for this start or the one it joined. */
const hostedSessionUnavailableError = (cause?: unknown) =>
  new HandlerError({
    status: 502,
    message: "Could not create hosted usage setup session",
    cause,
  });

const createHostedSetup = createSafeRootHandler(
  config,
  async function* ({ body, session, safeDb, user, recordAuditEvent }) {
    const credentials = getApiCredentials();
    if (!credentials) {
      return Result.err(
        new HandlerError({
          status: 502,
          message:
            "Hosted usage management is not configured on this deployment",
        }),
      );
    }

    const dbResult = yield* Result.await(
      safeDb(
        async (tx) =>
          await prepareCheckoutStart({
            tx,
            body,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          }),
      ),
    );
    switch (dbResult.kind) {
      case "ok":
        break;
      case "reuse":
        return Result.ok(dbResult.session);
      case "await": {
        const awaited = yield* Result.await(
          awaitHostedCheckoutSession({
            safeDb,
            organizationId: session.activeOrganizationId,
            claimId: dbResult.claimId,
            deadline: performance.now() + HOSTED_CHECKOUT_AWAIT_MS,
          }),
        );
        switch (awaited.kind) {
          case "reuse":
            return Result.ok(awaited.session);
          case "released":
            return Result.err(hostedSessionUnavailableError());
          case "checkout_open":
            return Result.err(checkoutRefusalError(awaited));
          default:
            awaited satisfies never;
            return panic("Unhandled awaited hosted checkout outcome");
        }
      }
      default:
        return Result.err(checkoutRefusalError(dbResult));
    }

    const baseUrl = env.FRONTEND_URL.endsWith("/")
      ? env.FRONTEND_URL.slice(0, -1)
      : env.FRONTEND_URL;
    // Build the post-setup destination server-side: accepting a
    // client-supplied success URL would turn the trusted hosted-setup
    // flow into an open redirect toward an arbitrary origin.
    const usageSettingsUrl = `${baseUrl}/settings/organization/usage`;
    // Always send the org-derived external customer ref. Polar's checkout
    // API links the resulting customer by external id, so it is required
    // there; the neutral provider still receives the existing account_ref
    // alongside it and can prefer that when present.
    const externalAccountRef = hostedExternalAccountRef(
      session.activeOrganizationId,
    );

    const sessionResult = await createHostedSetupSession({
      credentials,
      policyRef: dbResult.policyRef,
      accountRef: dbResult.accountRef ?? undefined,
      externalAccountRef,
      seats: body.seats,
      returnUrl: usageSettingsUrl,
      successUrl: usageSettingsUrl,
      metadata: {
        organization_id: session.activeOrganizationId,
        usage_policy_id: body.usagePolicyId,
        // seat_user_id identifies the seat that initiated hosted setup.
        // Useful for add-on allocations; harmless for entitlement setup.
        seat_user_id: user.id,
      },
    });
    if (dbResult.claimId !== null) {
      const settled = await settleHostedCheckoutClaim({
        safeDb,
        organizationId: session.activeOrganizationId,
        claimId: dbResult.claimId,
        recordAuditEvent,
        session: Result.isOk(sessionResult)
          ? {
              id: sessionResult.value.id,
              url: sessionResult.value.url,
              expiresAt: sessionResult.value.expiresAt,
            }
          : null,
      });
      // The provider outcome is already decided: a created session still
      // reaches the caller, and an unsettled claim lapses at its own expiry.
      if (Result.isError(settled)) {
        observeFailure(settled.error, {
          sink: CHECKOUT_CLAIM_SETTLE_FAILED,
          ctx: { organizationId: session.activeOrganizationId },
        });
      }
    }
    if (Result.isError(sessionResult)) {
      return Result.err(hostedSessionUnavailableError(sessionResult.error));
    }

    return Result.ok({
      hostedSessionId: sessionResult.value.id,
      url: sessionResult.value.url,
    });
  },
);

export default createHostedSetup;

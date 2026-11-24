import { panic, Result, TaggedError } from "better-result";
import { and, asc, count, eq } from "drizzle-orm";

import type {
  OrganizationSsoPendingMemberSummary,
  SsoPendingMemberReason,
} from "@stll/api-contract/sso";
import { declareFingerprintFields } from "@stll/errors";

import {
  member,
  organizationSsoPendingMember,
  organizationSsoPolicy,
  ssoProvider,
} from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { SsoManagementDb } from "@/api/lib/db/sso-management";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

const MAX_PENDING_MEMBERS_PER_ORG = 200;

export class SsoProvisioningError extends TaggedError(
  "sso_provisioning_error",
)<{
  message: string;
  reason: "pending_not_found" | "seat_limit_reached" | "already_reviewed";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export type SsoProvisioningOutcome =
  | { status: "already_member" }
  | { status: "invite_only" }
  | { status: "activated"; memberId: string }
  | { status: "pending"; pendingId: string; reason: SsoPendingMemberReason };

export const countOrganizationActiveSeats = async (
  db: SsoManagementDb,
  organizationId: SafeId<"organization">,
): Promise<number> => {
  const rows = await db
    .select({ total: count() })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  return rows.at(0)?.total ?? 0;
};

export const listOrganizationPendingSsoMembers = async (
  db: SsoManagementDb,
  organizationId: SafeId<"organization">,
): Promise<OrganizationSsoPendingMemberSummary[]> => {
  const read = await readBounded(
    db
      .select({
        id: organizationSsoPendingMember.id,
        userId: organizationSsoPendingMember.userId,
        email: organizationSsoPendingMember.email,
        name: organizationSsoPendingMember.name,
        reason: organizationSsoPendingMember.reason,
        status: organizationSsoPendingMember.status,
        createdAt: organizationSsoPendingMember.createdAt,
      })
      .from(organizationSsoPendingMember)
      .where(
        and(
          eq(organizationSsoPendingMember.organizationId, organizationId),
          eq(organizationSsoPendingMember.status, "pending"),
        ),
      )
      .orderBy(asc(organizationSsoPendingMember.createdAt)),
    MAX_PENDING_MEMBERS_PER_ORG,
  );
  const rows =
    read.type === "complete"
      ? read.rows
      : panic("Pending SSO member list exceeded bounded cap");

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    email: row.email,
    name: row.name,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));
};

/**
 * Evaluates an organization's SSO provisioning policy when a user signs in
 * through one of the organization's SSO providers:
 *
 * - Existing members pass through untouched.
 * - `invite_only`: no membership or pending request is created.
 * - `jit_active` under `seatLimit` (or unlimited): creates an active `member` row.
 * - `admin_approval`, or `jit_active` at/over `seatLimit`: records a `pending`
 *   request in `organization_sso_pending_member` with zero workspace access.
 */
export const provisionSsoMemberOnSignIn = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
    email: string;
    name?: string | null;
    ssoProviderId: string | null;
    now?: Date;
  },
): Promise<SsoProvisioningOutcome> =>
  await withAggregateTransaction(db, async (tx) => {
    await withAggregateLock({
      tx,
      aggregate: "organization",
      id: params.organizationId,
      mode: "update",
    });
    return await provisionSsoMemberOnSignInLocked(tx, params);
  });

const provisionSsoMemberOnSignInLocked = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
    email: string;
    name?: string | null;
    ssoProviderId: string | null;
    now?: Date;
  },
): Promise<SsoProvisioningOutcome> => {
  const existingMember = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
      ),
    )
    .limit(1);
  if (existingMember.length > 0) {
    return { status: "already_member" };
  }

  const policyRows = await db
    .select({
      provisioningMode: organizationSsoPolicy.provisioningMode,
      seatLimit: organizationSsoPolicy.seatLimit,
    })
    .from(organizationSsoPolicy)
    .where(eq(organizationSsoPolicy.organizationId, params.organizationId))
    .limit(1);

  const provisioningMode = policyRows.at(0)?.provisioningMode ?? "invite_only";
  const seatLimit = policyRows.at(0)?.seatLimit ?? null;

  if (provisioningMode === "invite_only") {
    return { status: "invite_only" };
  }

  const activeSeats = await countOrganizationActiveSeats(
    db,
    params.organizationId,
  );
  const atSeatLimit = seatLimit !== null && activeSeats >= seatLimit;
  const now = params.now ?? new Date();

  if (provisioningMode === "jit_active" && !atSeatLimit) {
    const memberId = Bun.randomUUIDv7();
    // audit: skip - SSO sign-in lifecycle event recorded at auth boundary
    await db
      .insert(member)
      .values({
        id: memberId,
        organizationId: params.organizationId,
        userId: params.userId,
        role: "member",
        createdAt: now,
      })
      .onConflictDoNothing();
    return { status: "activated", memberId };
  }

  const reason: SsoPendingMemberReason =
    provisioningMode === "admin_approval"
      ? "admin_approval"
      : "seat_limit_reached";

  const existingPending = await db
    .select({ id: organizationSsoPendingMember.id })
    .from(organizationSsoPendingMember)
    .where(
      and(
        eq(organizationSsoPendingMember.organizationId, params.organizationId),
        eq(organizationSsoPendingMember.userId, params.userId),
      ),
    )
    .limit(1);

  const existingId = existingPending.at(0)?.id;
  if (existingId !== undefined) {
    const write = replayWrite(
      organizationSsoPendingMember,
      {
        status: "pending" as const,
        reason,
        ssoProviderId: params.ssoProviderId,
        reviewedBy: null,
        reviewedAt: null,
      },
      {
        modifiedAt: {
          column: organizationSsoPendingMember.updatedAt,
          value: now,
        },
      },
    );
    // audit: skip - SSO sign-in lifecycle event recorded at auth boundary
    await db
      .update(organizationSsoPendingMember)
      .set(write.set)
      .where(
        and(
          eq(
            organizationSsoPendingMember.organizationId,
            params.organizationId,
          ),
          eq(organizationSsoPendingMember.id, existingId),
          write.setWhere,
        ),
      );
    return { status: "pending", pendingId: existingId, reason };
  }

  const pendingId = Bun.randomUUIDv7();
  // audit: skip - SSO sign-in lifecycle event recorded at auth boundary
  await db.insert(organizationSsoPendingMember).values({
    id: pendingId,
    organizationId: params.organizationId,
    userId: params.userId,
    email: params.email,
    name: params.name ?? null,
    ssoProviderId: params.ssoProviderId,
    reason,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  return { status: "pending", pendingId, reason };
};

export const approveOrganizationSsoPendingMember = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    pendingId: string;
    reviewedBy: SafeId<"user">;
    now?: Date;
  },
): Promise<Result<{ id: string; userId: string }, SsoProvisioningError>> =>
  await withAggregateTransaction(db, async (tx) => {
    await withAggregateLock({
      tx,
      aggregate: "organization",
      id: params.organizationId,
      mode: "update",
    });
    return await approveOrganizationSsoPendingMemberLocked(tx, params);
  });

const loadPendingSsoMember = async (
  db: SsoManagementDb,
  organizationId: SafeId<"organization">,
  pendingId: string,
) => {
  const rows = await db
    .select()
    .from(organizationSsoPendingMember)
    .where(
      and(
        eq(organizationSsoPendingMember.organizationId, organizationId),
        eq(organizationSsoPendingMember.id, pendingId),
      ),
    )
    .limit(1);

  const target = rows.at(0);
  if (target === undefined) {
    return Result.err(
      new SsoProvisioningError({
        message: "Pending SSO request not found",
        reason: "pending_not_found",
      }),
    );
  }
  if (target.status !== "pending") {
    return Result.err(
      new SsoProvisioningError({
        message: "Pending SSO request has already been reviewed",
        reason: "already_reviewed",
      }),
    );
  }
  return Result.ok(target);
};

const approveOrganizationSsoPendingMemberLocked = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    pendingId: string;
    reviewedBy: SafeId<"user">;
    now?: Date;
  },
): Promise<Result<{ id: string; userId: string }, SsoProvisioningError>> => {
  const loaded = await loadPendingSsoMember(
    db,
    params.organizationId,
    params.pendingId,
  );
  if (loaded.isErr()) {
    return loaded;
  }
  const target = loaded.value;

  const policyRows = await db
    .select({ seatLimit: organizationSsoPolicy.seatLimit })
    .from(organizationSsoPolicy)
    .where(eq(organizationSsoPolicy.organizationId, params.organizationId))
    .limit(1);
  const seatLimit = policyRows.at(0)?.seatLimit ?? null;
  if (seatLimit !== null) {
    const activeSeats = await countOrganizationActiveSeats(
      db,
      params.organizationId,
    );
    if (activeSeats >= seatLimit) {
      return Result.err(
        new SsoProvisioningError({
          message:
            "Organization seat limit reached. Remove a member or increase the seat limit before approving.",
          reason: "seat_limit_reached",
        }),
      );
    }
  }

  const now = params.now ?? new Date();
  // audit: skip - caller handler records organization settings audit event
  await db
    .insert(member)
    .values({
      id: Bun.randomUUIDv7(),
      organizationId: params.organizationId,
      userId: target.userId,
      role: "member",
      createdAt: now,
    })
    .onConflictDoNothing();

  const write = replayWrite(
    organizationSsoPendingMember,
    {
      status: "approved" as const,
      reviewedBy: params.reviewedBy,
      reviewedAt: now,
    },
    {
      modifiedAt: {
        column: organizationSsoPendingMember.updatedAt,
        value: now,
      },
    },
  );
  // audit: skip - caller handler records organization settings audit event
  await db
    .update(organizationSsoPendingMember)
    .set(write.set)
    .where(
      and(
        eq(organizationSsoPendingMember.organizationId, params.organizationId),
        eq(organizationSsoPendingMember.id, target.id),
        write.setWhere,
      ),
    );

  return Result.ok({ id: target.id, userId: target.userId });
};

export const rejectOrganizationSsoPendingMember = async (
  db: SsoManagementDb,
  params: {
    organizationId: SafeId<"organization">;
    pendingId: string;
    reviewedBy: SafeId<"user">;
    now?: Date;
  },
): Promise<Result<{ id: string; userId: string }, SsoProvisioningError>> => {
  const loaded = await loadPendingSsoMember(
    db,
    params.organizationId,
    params.pendingId,
  );
  if (loaded.isErr()) {
    return loaded;
  }
  const target = loaded.value;

  const now = params.now ?? new Date();
  const write = replayWrite(
    organizationSsoPendingMember,
    {
      status: "rejected" as const,
      reviewedBy: params.reviewedBy,
      reviewedAt: now,
    },
    {
      modifiedAt: {
        column: organizationSsoPendingMember.updatedAt,
        value: now,
      },
    },
  );
  // audit: skip - caller handler records organization settings audit event
  await db
    .update(organizationSsoPendingMember)
    .set(write.set)
    .where(
      and(
        eq(organizationSsoPendingMember.organizationId, params.organizationId),
        eq(organizationSsoPendingMember.id, target.id),
        write.setWhere,
      ),
    );

  return Result.ok({ id: target.id, userId: target.userId });
};

/**
 * Looks up the organization owning `ssoProviderRecordId` and evaluates its
 * provisioning policy for a user who just completed SSO sign-in.
 */
export const provisionSsoMemberByProviderRecord = async (
  db: SsoManagementDb,
  params: {
    ssoProviderRecordId: string;
    userId: SafeId<"user">;
    email: string;
    name?: string | null;
    now?: Date;
  },
): Promise<SsoProvisioningOutcome | null> => {
  const rows = await db
    .select({ organizationId: ssoProvider.organizationId })
    .from(ssoProvider)
    .where(eq(ssoProvider.id, params.ssoProviderRecordId))
    .limit(1);
  const orgId = rows.at(0)?.organizationId ?? null;
  if (orgId === null) {
    return null;
  }
  return await provisionSsoMemberOnSignIn(db, {
    organizationId: brandPersistedOrganizationId(orgId),
    userId: params.userId,
    email: params.email,
    name: params.name ?? null,
    ssoProviderId: params.ssoProviderRecordId,
    ...(params.now !== undefined ? { now: params.now } : {}),
  });
};

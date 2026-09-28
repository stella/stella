/**
 * Organization member capacity and per-member AI access.
 *
 * The capacity is the `organization_member_capacity` database function: an
 * organization whose access state is not `self_managed_keys` and whose usage
 * entitlement's policy sets `maxMembers` is bounded by it and, for a
 * per-seat policy, by its seat count. A policy without `maxMembers` (every
 * policy that predates the column) bounds nothing. The
 * `member_organization_capacity`
 * trigger enforces it inside every inserting transaction; the checks here
 * refuse earlier with a readable error, and only while
 * `FEATURE_ORG_ACCESS_STATE` is on, without a query while it is off.
 *
 * The same organizations admit only members holding a seat assignment to AI
 * work, whichever key pays for it.
 */

import { Result } from "better-result";
import { and, count, eq, gt, isNotNull, ne, sql } from "drizzle-orm";

import { invitation, member, organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import type { USAGE_POLICY_PRICE_BASES } from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const MEMBER_CAPACITY_REACHED_ERROR_CODE =
  "organization_member_capacity_reached";

const memberCapacityReachedError = () =>
  new HandlerError({
    code: MEMBER_CAPACITY_REACHED_ERROR_CODE,
    status: 409,
    message: "The organization has reached its member capacity",
  });

/**
 * The organization's member capacity, or null when nothing bounds it. Null
 * while the flag is off, without a query. The capacity function executes on
 * the owner connection only.
 */
export const readOrganizationMemberCapacity = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<number | null> => {
  if (!env.FEATURE_ORG_ACCESS_STATE) {
    return null;
  }
  const rows = await db
    .select({
      capacity: sql<
        number | null
      >`organization_member_capacity(${organization.id})`,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return rows.at(0)?.capacity ?? null;
};

const countMembers = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  return rows.at(0)?.value ?? 0;
};

const countPendingInvitations = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
        // Expiry resolves against the database clock, as the plugin's own
        // pending-invitation read does against the process clock.
        gt(invitation.expiresAt, sql`now()`),
      ),
    );
  return rows.at(0)?.value ?? 0;
};

type MemberAdmission = {
  organizationId: SafeId<"organization">;
  /**
   * `invitation` counts pending invitations as places already taken, so an
   * organization cannot invite more people than it can admit; `membership`
   * admits one more member (the invitation being accepted is not counted).
   */
  kind: "invitation" | "membership";
};

/**
 * Whether one more invitation or member fits the organization's capacity.
 * Invitation and membership reads run on the owner connection (the
 * invitation table is not visible to the app role).
 */
export const checkMemberAdmission = async (
  db: Pick<Transaction, "select">,
  { organizationId, kind }: MemberAdmission,
): Promise<Result<void, HandlerError<409>>> => {
  const capacity = await readOrganizationMemberCapacity(db, organizationId);
  if (capacity === null) {
    return Result.ok(undefined);
  }
  const members = await countMembers(db, organizationId);
  const pending =
    kind === "invitation"
      ? await countPendingInvitations(db, organizationId)
      : 0;
  return members + pending >= capacity
    ? Result.err(memberCapacityReachedError())
    : Result.ok(undefined);
};

export const MEMBER_CAPACITY_BELOW_MEMBERS_ERROR_CODE =
  "organization_member_capacity_below_members";

const memberCapacityBelowMembersError = () =>
  new HandlerError({
    code: MEMBER_CAPACITY_BELOW_MEMBERS_ERROR_CODE,
    status: 409,
    message:
      "The organization has more members than this change would allow. " +
      "Remove members first.",
  });

/**
 * The member capacity a usage policy grants at a seat count: the same bound
 * `organization_member_capacity` computes from a stored entitlement. A
 * policy without a member bound bounds nothing, whatever its seats.
 */
export const memberCapacityOf = ({
  maxMembers,
  priceBasis,
  seats,
}: {
  maxMembers: number | null;
  priceBasis: (typeof USAGE_POLICY_PRICE_BASES)[number];
  seats: number;
}): number | null => {
  if (maxMembers === null) {
    return null;
  }
  return priceBasis === "per_seat" ? Math.min(maxMembers, seats) : maxMembers;
};

/**
 * Refuses moving the organization to a capacity below its current member
 * count: a seat reduction or a policy with a lower member bound waits until
 * members leave, and no member is ever removed to make room. An organization
 * whose recorded state keeps it unbounded is not refused. Always allowed
 * while the flag is off, without a query.
 */
export const checkMemberCapacityChange = async (
  db: Pick<Transaction, "select">,
  {
    organizationId,
    nextCapacity,
  }: {
    organizationId: SafeId<"organization">;
    nextCapacity: number | null;
  },
): Promise<Result<void, HandlerError<409>>> => {
  if (!env.FEATURE_ORG_ACCESS_STATE || nextCapacity === null) {
    return Result.ok(undefined);
  }
  const bounded = await db
    .select({ organizationId: organizationAccessStates.organizationId })
    .from(organizationAccessStates)
    .where(
      and(
        eq(organizationAccessStates.organizationId, organizationId),
        ne(
          organizationAccessStates.state,
          ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        ),
      ),
    )
    .limit(1);
  if (bounded.at(0) === undefined) {
    return Result.ok(undefined);
  }
  const members = await countMembers(db, organizationId);
  return members > nextCapacity
    ? Result.err(memberCapacityBelowMembersError())
    : Result.ok(undefined);
};

/**
 * Whether the user may run AI work in the organization. In an organization
 * with a member capacity (see above), only a member holding a seat
 * assignment may, whether the organization's own key or the instance
 * provider would serve the work; anyone else is refused rather than served
 * from the organization's shared pool. Always true while the flag is off,
 * without a query.
 */
export const memberMayUseAI = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): Promise<boolean> => {
  if (!env.FEATURE_ORG_ACCESS_STATE) {
    return true;
  }
  const rows = await db
    .select({ assignmentId: usageSeatAssignments.id })
    .from(usageEntitlements)
    .innerJoin(
      usagePolicies,
      eq(usagePolicies.id, usageEntitlements.usagePolicyId),
    )
    .innerJoin(
      organizationAccessStates,
      eq(
        organizationAccessStates.organizationId,
        usageEntitlements.organizationId,
      ),
    )
    .leftJoin(
      usageSeatAssignments,
      and(
        eq(
          usageSeatAssignments.organizationId,
          usageEntitlements.organizationId,
        ),
        eq(usageSeatAssignments.userId, userId),
      ),
    )
    .where(
      and(
        eq(usageEntitlements.organizationId, organizationId),
        ne(
          organizationAccessStates.state,
          ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        ),
        isNotNull(usagePolicies.maxMembers),
      ),
    )
    .limit(1);
  const row = rows.at(0);
  return row === undefined || row.assignmentId !== null;
};

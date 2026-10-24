/**
 * Organization member capacity and per-member AI access.
 *
 * The capacity is the `organization_member_capacity` database function: an
 * organization whose access state is not `self_managed_keys` and whose
 * effective policy (`organization_effective_policy`: a live entitlement's
 * policy, or the free floor) sets `maxMembers` is bounded by it and, for a
 * per-seat policy, by its seat count. A policy without `maxMembers` (every
 * policy that predates the column) bounds nothing. The
 * `member_organization_capacity`
 * trigger enforces it inside every inserting transaction; the checks here
 * read the same bound, whatever `FEATURE_ORG_ACCESS_STATE` says, so a request
 * the trigger would stop is refused earlier with a readable error.
 *
 * While the flag is on, the same organizations admit only members holding a
 * seat assignment to AI work, whichever key pays for it.
 */

import { Result } from "better-result";
import { and, count, eq, gt, sql } from "drizzle-orm";

import { invitation, member, organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  usageSeatAssignments,
} from "@/api/db/schema";
import type { USAGE_POLICY_PRICE_BASES } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isSyntheticPrincipal } from "@/api/lib/synthetic-principal/constants";

export const MEMBER_CAPACITY_REACHED_ERROR_CODE =
  "organization_member_capacity_reached";

export const ORGANIZATION_ACCESS_STATE_REQUIRED_ERROR_CODE =
  "organization_access_state_required";

const memberCapacityReachedError = () =>
  new HandlerError({
    code: MEMBER_CAPACITY_REACHED_ERROR_CODE,
    status: 409,
    message: "The organization has reached its member capacity",
  });

const organizationAccessStateRequiredError = () =>
  new HandlerError({
    code: ORGANIZATION_ACCESS_STATE_REQUIRED_ERROR_CODE,
    status: 409,
    message: "The organization access state is not ready",
  });

const readOrganizationAccessState = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
) =>
  (
    await db
      .select({ state: organizationAccessStates.state })
      .from(organizationAccessStates)
      .where(eq(organizationAccessStates.organizationId, organizationId))
      .limit(1)
  ).at(0)?.state;

/**
 * The organization's member capacity, or null when nothing bounds it: the
 * value the member insert trigger enforces. The capacity function executes
 * on the owner connection only.
 */
export const readOrganizationMemberCapacity = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<number | null> => {
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
  if ((await readOrganizationAccessState(db, organizationId)) === undefined) {
    return Result.err(organizationAccessStateRequiredError());
  }
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
 * whose recorded state keeps it unbounded is not refused, and neither is a
 * capacity of null (a policy without a member bound).
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
  if (nextCapacity === null) {
    return Result.ok(undefined);
  }
  const accessState = await readOrganizationAccessState(db, organizationId);
  if (accessState === undefined) {
    return Result.err(organizationAccessStateRequiredError());
  }
  if (accessState === ORGANIZATION_ACCESS_STATE.selfManagedKeys) {
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
 * from the organization's shared pool. The monitoring principal is not
 * admitted. Current organization membership is always required; turning the
 * flag off skips only the seat-policy query.
 */
export const memberMayUseAI = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): Promise<boolean> => {
  if (isSyntheticPrincipal({ organizationId, userId })) {
    return false;
  }
  if (!isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE")) {
    const currentMember = (
      await db
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, userId),
          ),
        )
        .limit(1)
    ).at(0);
    return currentMember !== undefined;
  }
  const rows = await db
    .select({
      accessState: organizationAccessStates.state,
      assignmentId: usageSeatAssignments.id,
      requiresAssignment: sql<boolean>`${organizationAccessStates.state} <> ${ORGANIZATION_ACCESS_STATE.selfManagedKeys} AND exists (select 1 from organization_effective_policy(${organizationAccessStates.organizationId}) ep where ep.max_members is not null and ep.policy_kind <> 'free')`,
    })
    .from(member)
    .leftJoin(
      organizationAccessStates,
      eq(organizationAccessStates.organizationId, member.organizationId),
    )
    .leftJoin(
      usageSeatAssignments,
      and(
        eq(
          usageSeatAssignments.organizationId,
          organizationAccessStates.organizationId,
        ),
        eq(usageSeatAssignments.userId, member.userId),
      ),
    )
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  const row = rows.at(0);
  return (
    row !== undefined &&
    row.accessState !== null &&
    (!row.requiresAssignment || row.assignmentId !== null)
  );
};

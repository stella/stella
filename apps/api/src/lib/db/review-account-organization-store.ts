import { generateId } from "@better-auth/core/utils/id";
import { and, eq } from "drizzle-orm";

import { invitation, member, organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { ensureDefaultDocumentTypes } from "@/api/lib/document-types/defaults";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";

// Better Auth's default id length, the shape every auth row holds.
const AUTH_ID_LENGTH = 32;
const ORGANIZATION_NAME = "Sample law firm";

type OwnerDatabase = Pick<Transaction, "select" | "transaction">;

type OwnerMembership = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type ProvisioningCause =
  | "review_account_organization_created"
  | "review_account_owner_added"
  | "review_account_owner_promoted"
  | "review_account_invitations_canceled";

const provisioningAuditBindings = ({
  organizationId,
  userId,
}: OwnerMembership) => ({
  execution: {
    performer: {
      type: "service" as const,
      id: "review-account-provisioning",
      name: "Review account provisioning",
    },
    trigger: {
      type: "system" as const,
      source: "review_account_provisioning",
    },
  },
  organizationId,
  userId,
  workspaceId: null,
});

const provisioningAuditEvent = (
  organizationId: SafeId<"organization">,
  cause: ProvisioningCause,
) => ({
  action:
    cause === "review_account_organization_created"
      ? AUDIT_ACTION.CREATE
      : AUDIT_ACTION.UPDATE,
  resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
  resourceId: organizationId,
  metadata: { cause },
});

const insertOwner = async (tx: Transaction, membership: OwnerMembership) => {
  const { organizationId, userId } = membership;
  const recordAuditEvent = createBackgroundAuditRecorder(
    provisioningAuditBindings(membership),
  );
  // A direct insert skips the organization plugin's membership hooks, so the
  // member defaults a real new owner gets are installed here.
  await tx.insert(member).values({
    id: generateId(AUTH_ID_LENGTH),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await seedDefaultSkills({ organizationId, tx, userId });
  await recordAuditEvent(
    tx,
    provisioningAuditEvent(organizationId, "review_account_owner_added"),
  );
};

/**
 * The organization half of the restricted review account's provisioning. The
 * organization plugin refuses that account by policy, so its organization and
 * single owner membership are written here, with the seeds the plugin's
 * creation hooks would add and an audit event for each write. The connection
 * owner binds this to the owner connection (`db/root.ts`); callers never
 * receive a database handle.
 */
export const createReviewAccountOrganizationStore = (db: OwnerDatabase) => ({
  organizationExists: async (organizationId: SafeId<"organization">) =>
    (
      await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1)
    ).length > 0,
  listMembers: async (organizationId: SafeId<"organization">) =>
    await db
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, organizationId)),
  listOrganizationIdsForUser: async (userId: SafeId<"user">) =>
    (
      await db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, userId))
    ).map((row) => row.organizationId),
  createOrganization: async ({
    organizationId,
    ownerUserId,
  }: {
    organizationId: SafeId<"organization">;
    ownerUserId: SafeId<"user">;
  }) => {
    const membership = { organizationId, userId: ownerUserId };
    // One transaction: the organization, its recorded state and starter
    // taxonomy, and the owner membership land together or not at all.
    await db.transaction(async (tx) => {
      const recordAuditEvent = createBackgroundAuditRecorder(
        provisioningAuditBindings(membership),
      );
      const now = new Date();
      await tx.insert(organization).values({
        id: organizationId,
        name: ORGANIZATION_NAME,
        slug: `review-${organizationId.toLowerCase()}`,
        createdAt: now,
      });
      await recordNewOrganizationAccessState(tx, { organizationId, now });
      await ensureDefaultDocumentTypes(organizationId, tx);
      await recordAuditEvent(
        tx,
        provisioningAuditEvent(
          organizationId,
          "review_account_organization_created",
        ),
      );
      await insertOwner(tx, membership);
    });
  },
  /** Deletes every pending invitation into the organization. */
  cancelPendingInvitations: async (membership: OwnerMembership) =>
    await db.transaction(async (tx) => {
      const recordAuditEvent = createBackgroundAuditRecorder(
        provisioningAuditBindings(membership),
      );
      const canceled = await tx
        .delete(invitation)
        .where(
          and(
            eq(invitation.organizationId, membership.organizationId),
            eq(invitation.status, "pending"),
          ),
        )
        .returning({ id: invitation.id });
      if (canceled.length > 0) {
        await recordAuditEvent(
          tx,
          provisioningAuditEvent(
            membership.organizationId,
            "review_account_invitations_canceled",
          ),
        );
      }
      return canceled.length;
    }),
  /** Makes an existing sole membership the organization's owner. */
  promoteToOwner: async (membership: OwnerMembership) => {
    await db.transaction(async (tx) => {
      const recordAuditEvent = createBackgroundAuditRecorder(
        provisioningAuditBindings(membership),
      );
      await tx
        .update(member)
        .set({ role: "owner" })
        .where(
          and(
            eq(member.organizationId, membership.organizationId),
            eq(member.userId, membership.userId),
          ),
        );
      await recordAuditEvent(
        tx,
        provisioningAuditEvent(
          membership.organizationId,
          "review_account_owner_promoted",
        ),
      );
    });
  },
  addOwner: async (membership: OwnerMembership) => {
    await db.transaction(async (tx) => {
      await insertOwner(tx, membership);
    });
  },
});

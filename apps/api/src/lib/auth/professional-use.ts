import { panic, TaggedError } from "better-result";
import { eq } from "drizzle-orm";

import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";

import type { Transaction } from "@/api/db/root";
import {
  organizationProfessionalUseAcceptances,
  userProfessionalUseAcceptances,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const PROFESSIONAL_USE_AUDIT_FIELD = "professionalUseAcceptance";

/**
 * Record that a new account accepted the current professional-use statement
 * by being created. Insert-once: a repeated call keeps the first acceptance.
 */
export const recordUserProfessionalUse = async (
  db: Pick<Transaction, "insert">,
  userId: SafeId<"user">,
): Promise<void> => {
  // audit: skip - audit rows are organization-scoped; the organization acceptance row is audited
  await db
    .insert(userProfessionalUseAcceptances)
    .values({
      userId,
      statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    })
    .onConflictDoNothing({ target: userProfessionalUseAcceptances.userId });
};

type OrganizationProfessionalUseOutcome =
  | { status: "recorded"; statementVersion: string; termsVersion: string }
  | { status: "already_recorded" }
  | { status: "creator_acceptance_missing" };

type RecordOrganizationProfessionalUseOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * Record the acceptance an organization is created under: the versions its
 * creator accepted, read in this transaction, never the current ones. A
 * creator without an acceptance records nothing. Insert-once, audited in the
 * same transaction.
 */
export const recordOrganizationProfessionalUse = async ({
  tx,
  organizationId,
  userId,
}: RecordOrganizationProfessionalUseOptions): Promise<OrganizationProfessionalUseOutcome> => {
  const creatorRows = await tx
    .select({
      statementVersion: userProfessionalUseAcceptances.statementVersion,
      termsVersion: userProfessionalUseAcceptances.termsVersion,
    })
    .from(userProfessionalUseAcceptances)
    .where(eq(userProfessionalUseAcceptances.userId, userId))
    .limit(1);
  const creator = creatorRows.at(0);
  if (creator === undefined) {
    return { status: "creator_acceptance_missing" };
  }
  const inserted = await tx
    .insert(organizationProfessionalUseAcceptances)
    .values({ organizationId, acceptedByUserId: userId, ...creator })
    .onConflictDoNothing({
      target: organizationProfessionalUseAcceptances.organizationId,
    })
    .returning({
      organizationId: organizationProfessionalUseAcceptances.organizationId,
    });
  if (inserted.at(0) === undefined) {
    return { status: "already_recorded" };
  }
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    workspaceId: null,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "direct" },
    },
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    metadata: { field: PROFESSIONAL_USE_AUDIT_FIELD, ...creator },
  });
  return { status: "recorded", ...creator };
};

class CreatorProfessionalUseMissingError extends TaggedError(
  "CreatorProfessionalUseMissingError",
)<{ message: string }> {}

const CREATOR_PROFESSIONAL_USE_MISSING = failureSink({
  event: "auth.professional_use.creator_acceptance_missing",
  expected: [],
});

type ReportOrganizationProfessionalUseOptions = {
  outcome: OrganizationProfessionalUseOutcome;
  organizationId: SafeId<"organization">;
};

/**
 * Report an organization created by an account without a recorded
 * acceptance: the organization stays without one rather than carrying a
 * fabricated record.
 */
export const reportOrganizationProfessionalUse = ({
  outcome,
  organizationId,
}: ReportOrganizationProfessionalUseOptions): void => {
  switch (outcome.status) {
    case "recorded":
    case "already_recorded":
      return;
    case "creator_acceptance_missing":
      observeFailure(
        new CreatorProfessionalUseMissingError({
          message:
            "Organization created by an account without a professional-use acceptance",
        }),
        {
          sink: CREATOR_PROFESSIONAL_USE_MISSING,
          ctx: { organizationId, operation: "organization.create" },
        },
      );
      return;
    default:
      outcome satisfies never;
      panic("Unhandled organization professional-use outcome");
  }
};

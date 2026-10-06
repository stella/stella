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

/**
 * The professional-use statement shown where accounts are created
 * (`auth.professionalUseStatement` in the web catalogs). A changed statement
 * gets a new version.
 */
export const PROFESSIONAL_USE_STATEMENT_VERSION = "2026-10";

/** The terms of service the statement is accepted under. */
export const PROFESSIONAL_USE_TERMS_VERSION = "2026-10";

const PROFESSIONAL_USE_AUDIT_FIELD = "professionalUseAcceptance";

/**
 * Record that a new account accepted the professional-use statement by being
 * created. Insert-once: a repeated call keeps the first acceptance.
 */
export const recordUserProfessionalUse = async (
  db: Pick<Transaction, "insert">,
  userId: SafeId<"user">,
): Promise<void> => {
  await db
    .insert(userProfessionalUseAcceptances)
    .values({
      userId,
      statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    })
    .onConflictDoNothing({ target: userProfessionalUseAcceptances.userId });
};

type RecordOrganizationProfessionalUseOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * Record the acceptance an organization is created under, with the account
 * that created it, and audit it in the same transaction. Insert-once.
 */
export const recordOrganizationProfessionalUse = async ({
  tx,
  organizationId,
  userId,
}: RecordOrganizationProfessionalUseOptions): Promise<void> => {
  const inserted = await tx
    .insert(organizationProfessionalUseAcceptances)
    .values({
      organizationId,
      acceptedByUserId: userId,
      statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    })
    .onConflictDoNothing({
      target: organizationProfessionalUseAcceptances.organizationId,
    })
    .returning({
      organizationId: organizationProfessionalUseAcceptances.organizationId,
    });
  if (inserted.at(0) === undefined) {
    return;
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
    metadata: {
      field: PROFESSIONAL_USE_AUDIT_FIELD,
      statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    },
  });
};

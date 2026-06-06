import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

type ActorSessionIdentityInput = {
  organizationId: string;
  userId: string;
};

type WorkflowActorKeyInput = {
  organizationId: string;
  workspaceId: string;
};

export const brandActorSessionIdentity = ({
  organizationId,
  userId,
}: ActorSessionIdentityInput): {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
} => ({
  organizationId: toSafeId<"organization">(organizationId),
  userId: toSafeId<"user">(userId),
});

export const brandPersistedWorkspaceId = (
  workspaceId: string,
): SafeId<"workspace"> => toSafeId<"workspace">(workspaceId);

export const brandPersistedEntityId = (entityId: string): SafeId<"entity"> =>
  toSafeId<"entity">(entityId);

export const brandPersistedFieldId = (fieldId: string): SafeId<"field"> =>
  toSafeId<"field">(fieldId);

export const brandPersistedPropertyId = (
  propertyId: string,
): SafeId<"property"> => toSafeId<"property">(propertyId);

export const brandPersistedUserFileId = (
  userFileId: string,
): SafeId<"userFile"> => toSafeId<"userFile">(userFileId);

export const brandPersistedDesktopEditSessionId = (
  desktopEditSessionId: string,
): SafeId<"desktopEditSession"> =>
  toSafeId<"desktopEditSession">(desktopEditSessionId);

export const brandPersistedChatThreadId = (
  chatThreadId: string,
): SafeId<"chatThread"> => toSafeId<"chatThread">(chatThreadId);

export const brandPersistedChatMessageId = (
  chatMessageId: string,
): SafeId<"chatMessage"> => toSafeId<"chatMessage">(chatMessageId);

export const brandPersistedCaseLawDecisionId = (
  caseLawDecisionId: string,
): SafeId<"caseLawDecision"> => toSafeId<"caseLawDecision">(caseLawDecisionId);

export const brandPersistedCaseLawSourceId = (
  caseLawSourceId: string,
): SafeId<"caseLawSource"> => toSafeId<"caseLawSource">(caseLawSourceId);

export const brandPersistedContactId = (contactId: string): SafeId<"contact"> =>
  toSafeId<"contact">(contactId);

export const brandPersistedAuditLogId = (
  auditLogId: string,
): SafeId<"auditLog"> => toSafeId<"auditLog">(auditLogId);

export const brandPersistedBillingCodeId = (
  billingCodeId: string,
): SafeId<"billingCode"> => toSafeId<"billingCode">(billingCodeId);

export const brandPersistedClauseId = (clauseId: string): SafeId<"clause"> =>
  toSafeId<"clause">(clauseId);

export const brandPersistedExpenseId = (expenseId: string): SafeId<"expense"> =>
  toSafeId<"expense">(expenseId);

export const brandPersistedInvoiceId = (invoiceId: string): SafeId<"invoice"> =>
  toSafeId<"invoice">(invoiceId);

export const brandPersistedRateEntryId = (
  rateEntryId: string,
): SafeId<"rateEntry"> => toSafeId<"rateEntry">(rateEntryId);

export const brandPersistedRateTableId = (
  rateTableId: string,
): SafeId<"rateTable"> => toSafeId<"rateTable">(rateTableId);

export const brandPersistedTimeEntryId = (
  timeEntryId: string,
): SafeId<"timeEntry"> => toSafeId<"timeEntry">(timeEntryId);

export const brandPersistedUserId = (userId: string): SafeId<"user"> =>
  toSafeId<"user">(userId);

export const brandPersistedOrganizationId = (
  organizationId: string,
): SafeId<"organization"> => toSafeId<"organization">(organizationId);

export const brandValidatedWorkflowActorKey = ({
  organizationId,
  workspaceId,
}: WorkflowActorKeyInput): {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
} => ({
  organizationId: toSafeId<"organization">(organizationId),
  workspaceId: toSafeId<"workspace">(workspaceId),
});

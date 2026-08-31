import { toSafeId } from "@/api/lib/branded-types";
import type { AuthProviderIdType, SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";

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

export const brandPersistedTemplateId = (
  templateId: string,
): SafeId<"template"> => toSafeId<"template">(templateId);

export const brandPersistedStyleSetId = (
  styleSetId: string,
): SafeId<"styleSet"> => toSafeId<"styleSet">(styleSetId);

export const brandPersistedAiMemoryId = (
  aiMemoryId: string,
): SafeId<"aiMemory"> => toSafeId<"aiMemory">(aiMemoryId);

/**
 * A property id derived from a stable seed rather than minted: the same seed
 * always yields the same id, which is what lets a prompt built from these ids
 * repeat byte-for-byte. Shaped like a UUID so every consumer of property ids
 * treats it as one.
 */
export const brandDerivedPropertyId = (seed: string): SafeId<"property"> => {
  const digest = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
  return toSafeId<"property">(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
  );
};

export const brandPersistedEntityId = (entityId: string): SafeId<"entity"> =>
  toSafeId<"entity">(entityId);

export const brandPersistedReportExportId = (
  reportExportId: string,
): SafeId<"reportExport"> => toSafeId<"reportExport">(reportExportId);

export const brandPersistedFieldId = (fieldId: string): SafeId<"field"> =>
  toSafeId<"field">(fieldId);

export const brandPersistedPendingUploadId = (
  pendingUploadId: string,
): SafeId<"pendingUpload"> => toSafeId<"pendingUpload">(pendingUploadId);

export const brandPersistedEntityVersionId = (
  entityVersionId: string,
): SafeId<"entityVersion"> => toSafeId<"entityVersion">(entityVersionId);

export const brandPersistedDocxSuggestionId = (
  docxSuggestionId: string,
): SafeId<"docxSuggestion"> => toSafeId<"docxSuggestion">(docxSuggestionId);

export const brandPersistedBilingualTranslationRunId = (
  runId: string,
): SafeId<"bilingualTranslationRun"> =>
  toSafeId<"bilingualTranslationRun">(runId);

export const brandPersistedDocumentReviewRunId = (
  runId: string,
): SafeId<"documentReviewRun"> => toSafeId<"documentReviewRun">(runId);

export const brandPersistedDocumentTranslationRunId = (
  runId: string,
): SafeId<"documentTranslationRun"> =>
  toSafeId<"documentTranslationRun">(runId);

export const brandPersistedLegalListId = (
  listId: string,
): SafeId<"legalList"> => toSafeId<"legalList">(listId);

export const brandPersistedLegalListSectionId = (
  sectionId: string,
): SafeId<"legalListSection"> => toSafeId<"legalListSection">(sectionId);

export const brandPersistedLegalListGenerationRunId = (
  runId: string,
): SafeId<"legalListGenerationRun"> =>
  toSafeId<"legalListGenerationRun">(runId);

export const brandPersistedLegalListItemSourceId = (
  sourceId: string,
): SafeId<"legalListItemSource"> => toSafeId<"legalListItemSource">(sourceId);

export const brandPersistedLegalListGenerationCandidateId = (
  candidateId: string,
): SafeId<"legalListGenerationCandidate"> =>
  toSafeId<"legalListGenerationCandidate">(candidateId);

export const brandPersistedPropertyId = (
  propertyId: string,
): SafeId<"property"> => toSafeId<"property">(propertyId);

export const brandPersistedPlaybookId = (
  playbookId: string,
): SafeId<"playbook"> => toSafeId<"playbook">(playbookId);

export const brandPersistedPlaybookDefinitionId = (
  playbookDefinitionId: string,
): SafeId<"playbookDefinition"> =>
  toSafeId<"playbookDefinition">(playbookDefinitionId);

export const brandPersistedFlowDefinitionId = (
  flowDefinitionId: string,
): SafeId<"flowDefinition"> => toSafeId<"flowDefinition">(flowDefinitionId);

export const brandPersistedFlowRunId = (flowRunId: string): SafeId<"flowRun"> =>
  toSafeId<"flowRun">(flowRunId);

export const brandPersistedExtractionRunId = (
  extractionRunId: string,
): SafeId<"extractionRun"> => toSafeId<"extractionRun">(extractionRunId);

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

export const brandPersistedChatThreadCompactionId = (
  chatThreadCompactionId: string,
): SafeId<"chatThreadCompaction"> =>
  toSafeId<"chatThreadCompaction">(chatThreadCompactionId);

export const brandPersistedChatMessageId = (
  chatMessageId: string,
): SafeId<"chatMessage"> => toSafeId<"chatMessage">(chatMessageId);

export const brandPersistedCaseLawDecisionId = (
  caseLawDecisionId: string,
): SafeId<"caseLawDecision"> => toSafeId<"caseLawDecision">(caseLawDecisionId);

export const brandPersistedCaseLawDecisionAnnotationId = (
  caseLawDecisionAnnotationId: string,
): SafeId<"caseLawDecisionAnnotation"> =>
  toSafeId<"caseLawDecisionAnnotation">(caseLawDecisionAnnotationId);

export const brandPersistedCaseLawCitationId = (
  caseLawCitationId: string,
): SafeId<"caseLawCitation"> => toSafeId<"caseLawCitation">(caseLawCitationId);

export const brandPersistedCaseLawSourceId = (
  caseLawSourceId: string,
): SafeId<"caseLawSource"> => toSafeId<"caseLawSource">(caseLawSourceId);

export const brandPersistedLegislationDocumentId = (
  legislationDocumentId: string,
): SafeId<"legislationDocument"> =>
  toSafeId<"legislationDocument">(legislationDocumentId);

export const brandValidatedCorpusIndexProjectionIntentId = (
  intentId: string,
): SafeId<"corpusIndexProjectionIntent"> | null =>
  isUuid(intentId) ? toSafeId<"corpusIndexProjectionIntent">(intentId) : null;

export const brandPersistedContactId = (contactId: string): SafeId<"contact"> =>
  toSafeId<"contact">(contactId);

export const brandPersistedWorkspaceContactId = (
  workspaceContactId: string,
): SafeId<"workspaceContact"> =>
  toSafeId<"workspaceContact">(workspaceContactId);

export const brandPersistedEntityLinkId = (
  entityLinkId: string,
): SafeId<"entityLink"> => toSafeId<"entityLink">(entityLinkId);

export const brandPersistedAuditLogId = (
  auditLogId: string,
): SafeId<"auditLog"> => toSafeId<"auditLog">(auditLogId);

export const brandPersistedAgentSkillId = (
  agentSkillId: string,
): SafeId<"agentSkill"> => toSafeId<"agentSkill">(agentSkillId);

export const brandPersistedBillingCodeId = (
  billingCodeId: string,
): SafeId<"billingCode"> => toSafeId<"billingCode">(billingCodeId);

export const brandPersistedClauseId = (clauseId: string): SafeId<"clause"> =>
  toSafeId<"clause">(clauseId);

export const brandPersistedClauseCategoryId = (
  clauseCategoryId: string,
): SafeId<"clauseCategory"> => toSafeId<"clauseCategory">(clauseCategoryId);

export const brandPersistedClauseVersionId = (
  clauseVersionId: string,
): SafeId<"clauseVersion"> => toSafeId<"clauseVersion">(clauseVersionId);

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

export const brandPersistedSavedSearchId = (
  savedSearchId: string,
): SafeId<"savedSearch"> => toSafeId<"savedSearch">(savedSearchId);

export const brandPersistedTimeEntryId = (
  timeEntryId: string,
): SafeId<"timeEntry"> => toSafeId<"timeEntry">(timeEntryId);

export const brandPersistedUserId = (userId: string): SafeId<"user"> =>
  toSafeId<"user">(userId);

export const brandPersistedOrganizationId = (
  organizationId: string,
): SafeId<"organization"> => toSafeId<"organization">(organizationId);

/**
 * Widest shape any supported auth id generator emits (`AUTH_DATABASE_ID_OPTIONS`
 * declares none, so the default base62 applies; a configured generator may
 * produce UUIDs). Pinned against the real generator in
 * `safe-id-boundaries.test.ts`.
 */
export const AUTH_PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * Validate an auth-provider id received from outside the database (webhook
 * metadata, a dev seed, a row about to be branded) before branding it. The
 * type parameter is closed over `AuthProviderIdType`, so a UUID-only parser
 * cannot be pointed at one of these ids and this parser cannot brand a minted
 * one.
 */
export const parseAuthProviderId = <T extends AuthProviderIdType>(
  value: string,
): SafeId<T> | null =>
  AUTH_PROVIDER_ID_PATTERN.test(value) ? toSafeId<T>(value) : null;

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

/**
 * Parse a JSON-encoded list of client-picked entity ids (multipart bodies
 * carry it as a string field) into branded ids. Returns null when the JSON
 * is not an array of UUID strings or exceeds `maxItems`. Branding only
 * asserts the format — every consumer must still scope its queries to the
 * caller's organization and accessible workspaces.
 */
export const parsePickedEntityIdsJson = (
  json: string,
  maxItems: number,
): SafeId<"entity">[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > maxItems) {
    return null;
  }
  const ids: SafeId<"entity">[] = [];
  for (const id of parsed) {
    if (typeof id !== "string" || !isUuid(id)) {
      return null;
    }
    ids.push(toSafeId<"entity">(id));
  }
  return ids;
};

export const brandPersistedSignalId = (signalId: string): SafeId<"signal"> =>
  toSafeId<"signal">(signalId);

export const brandPersistedNotificationId = (
  notificationId: string,
): SafeId<"notification"> => toSafeId<"notification">(notificationId);

import * as v from "valibot";

import {
  isSafeIdValue,
  type SafeId as PortableSafeId,
} from "@stll/api-contract";

const safeIdSchema = v.pipe(
  v.string(),
  v.check(isSafeIdValue, "Expected a non-empty identifier"),
  v.brand("SafeId"),
);

export type SafeIdType =
  | "accountDeletionRequest"
  | "agentSkill"
  | "agentSkillComment"
  | "agentSkillProposal"
  | "agentSkillResource"
  | "agentSkillRevision"
  | "aiMemory"
  | "anonymizationAllowlistEntry"
  | "anonymizationBlacklistEntry"
  | "auditLog"
  | "billingCode"
  | "caseLawCitation"
  | "caseLawCitationResolutionCensusRun"
  | "caseLawCoverageSlice"
  | "caseLawCourtWeight"
  | "caseLawDecision"
  | "caseLawDecisionAnnotation"
  | "caseLawCorpusUploadIntent"
  | "caseLawIndexJob"
  | "caseLawIngestionEvent"
  | "caseLawIngestionFailure"
  | "caseLawMatterLink"
  | "caseLawPolarityRule"
  | "caseLawProvisionCitation"
  | "caseLawReconciliationItem"
  | "caseLawSource"
  | "caseLawSourceIngestionLease"
  | "chatMessage"
  | "chatTurn"
  | "chatThreadCompaction"
  | "chatThread"
  | "fileChatThread"
  | "templateChatThread"
  | "templateDeletionCleanupRequest"
  | "clause"
  | "clauseCategory"
  | "clauseVariant"
  | "clauseVersion"
  | "contact"
  | "contactExtractionUpload"
  | "contactImportRequest"
  | "contactRelationship"
  | "corpusIndexProjectionIntent"
  | "usageAllocation"
  | "usageLaneCounter"
  | "usageSeatAssignment"
  | "usagePolicy"
  | "usageEntitlement"
  | "usageEvent"
  | "desktopEditHandoff"
  | "desktopEditSession"
  | "bilingualTranslationRun"
  | "bilingualTranslationRow"
  | "docxSuggestion"
  | "document"
  | "documentCounter"
  | "entityDeletionCleanupRequest"
  | "accountDeletionEffectChunk"
  | "entityDeletionEffectChunk"
  | "effectLease"
  | "documentProcessingRun"
  | "documentReviewFinding"
  | "documentReviewRun"
  | "documentTranslationRun"
  | "documentTranslationUnit"
  | "documentType"
  | "entity"
  | "entityVersionAiSummary"
  | "entityVersion"
  | "expense"
  | "extractionRun"
  | "field"
  | "flowDefinition"
  | "flowRun"
  | "flowRunStep"
  | "folioCollabRoom"
  | "folioCollabRoomToken"
  | "folder"
  | "infoSoudTrackedCase"
  | "invoice"
  | "justification"
  | "legislationDocument"
  | "legislationIndexJob"
  | "legislationSource"
  | "legalList"
  | "legalListColumn"
  | "legalListGenerationCandidate"
  | "legalListGenerationCandidateSource"
  | "legalListGenerationRun"
  | "legalListGenerationSource"
  | "legalListItemComment"
  | "legalListItemReview"
  | "legalListItemSource"
  | "legalListSection"
  | "matter"
  | "matterCounter"
  | "mcpConnector"
  | "mcpOAuthClient"
  | "mcpUserConnection"
  | "organization"
  | "organizationSettings"
  | "pendingUpload"
  | "playbook"
  | "playbookDefinition"
  | "playbookDefinitionVersion"
  | "property"
  | "propertyDependency"
  | "rateEntry"
  | "rateTable"
  | "savedSearch"
  | "reportExport"
  | "schedulerJobRun"
  | "sharepointConnection"
  | "sharepointOAuthState"
  | "styleSet"
  | "taskAssignee"
  | "task"
  | "template"
  | "templateCategory"
  | "templateClause"
  | "templateRecipe"
  | "templateFill"
  | "templatePersistenceRequest"
  | "templateVersion"
  | "timeEntry"
  | "user"
  | "userFile"
  | "workspace"
  | "workspaceContact"
  | "workspaceMember"
  | "workspaceView"
  | "workspaceViewTemplate"
  | "workObligationEvent"
  | "entityLink";

export type SafeId<T extends SafeIdType> = PortableSafeId<T>;

/**
 * Id types minted by the auth provider rather than by `createSafeId`. Their
 * columns are opaque text, never `uuid`: Better Auth's default generator
 * produces 32 base62 characters, and a configured generator may produce
 * UUIDs. Nothing in this codebase mints one; `createSafeId` refuses these
 * types so a fixture or handler cannot invent a UUID-shaped user id that no
 * real row ever carries. Parse one with `parseAuthProviderId`; tests mint
 * them with `mintAuthProviderId`.
 */
export const AUTH_PROVIDER_ID_TYPES = [
  "organization",
  "user",
] as const satisfies readonly SafeIdType[];

export type AuthProviderIdType = (typeof AUTH_PROVIDER_ID_TYPES)[number];

/** Id types this codebase mints itself, as UUIDv7. */
export type MintedSafeIdType = Exclude<SafeIdType, AuthProviderIdType>;

export const toSafeId = <T extends SafeIdType>(value: string): SafeId<T> =>
  v.parse(safeIdSchema, value);

export const createSafeId = <T extends MintedSafeIdType>(): SafeId<T> =>
  toSafeId<T>(Bun.randomUUIDv7());

// parser-output-unchanged: Removal retry ID branding does not change parsed decision identities.
// parser-output-unchanged: Adding citation doctrine review, search-history, chat revision, reader answer and chat tool grant ID kinds does not change parser IDs or parsed records.
// parser-output-unchanged: [at-asylgh] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-bks] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-bvwg] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-courts] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-findok] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-lvwg] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-ubas] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-umse] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-uvs] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-verg] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-vfgh] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [at-vwgh] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [cz-ns] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [cz-nss] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [cz-regional] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [cz-us] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [eu-ecj] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [hu-bhgy] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-courts] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-kio] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-kis] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-ncourt] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-nsa] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-sn] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-tk] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-uodo] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [pl-uokik] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [sk-us] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
// parser-output-unchanged: [us-courtlistener] The request receipt ID kind leaves outputs identical in the #6013 parser-output-diff run (origin/main ade1138 vs head 97a8deb).
import * as v from "valibot";

export { isUuid } from "@stll/uuid-codec";

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
  | "savedTimeNarrative"
  | "caseLawCitation"
  | "caseLawCitationReview"
  | "caseLawCitationDoctrineReview"
  | "caseLawCitationResolutionCensusRun"
  | "caseLawCoverageSlice"
  | "caseLawCourtWeight"
  | "caseLawDecision"
  | "caseLawCorpusUploadIntent"
  | "caseLawIndexJob"
  | "caseLawIngestionEvent"
  | "caseLawIngestionFailure"
  | "caseLawJudge"
  | "caseLawMatterLink"
  | "caseLawPolarityRule"
  | "caseLawProvisionCitation"
  | "caseLawReconciliationItem"
  | "caseLawRemovalReconciliationItem"
  | "caseLawResearchAnswerClaim"
  | "caseLawResearchColumn"
  | "caseLawSource"
  | "caseLawSourceIngestionLease"
  | "chatMessage"
  | "chatMessageRevision"
  | "chatTurn"
  | "chatThreadCompaction"
  | "chatThread"
  | "chatToolGrant"
  | "fileChatThread"
  | "templateChatThread"
  | "templateDeletionCleanupRequest"
  | "clause"
  | "clauseCategory"
  | "clauseVariant"
  | "clauseVersion"
  | "contact"
  | "correspondence"
  | "correspondenceFiler"
  | "correspondenceAttachment"
  | "matterInboundAddress"
  | "correspondenceAllowedSender"
  | "correspondenceAllowedSenderMatter"
  | "correspondenceDropLog"
  | "contactExtractionUpload"
  | "contactImportRequest"
  | "requestIdempotencyReceipt"
  | "contactRelationship"
  | "corpusIndexProjectionIntent"
  | "hostedCheckoutClaim"
  | "usageAllocation"
  | "usageLaneCounter"
  | "usageSeatAssignment"
  | "usagePolicy"
  | "usageEntitlement"
  | "usageEvent"
  | "desktopEditHandoff"
  | "desktopEditSession"
  | "legalListClaim"
  | "legalListClaimReviewEvent"
  | "legalListVerificationRun"
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
  | "documentReferenceCounter"
  | "documentReviewFinding"
  | "documentReviewFindingDecision"
  | "documentReviewParty"
  | "documentReviewReferencePassage"
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
  | "fileComparisonUpload"
  | "flowDefinition"
  | "flowRun"
  | "flowRunStep"
  | "feedbackReport"
  | "signal"
  | "signalEvent"
  | "scoutRun"
  | "systemScriptRun"
  | "folioCollabRoom"
  | "folioCollabRoomToken"
  | "folioCollabContribution"
  | "folioCollabPublication"
  | "folder"
  | "infoSoudTrackedCase"
  | "invoice"
  | "invoiceLine"
  | "invoicePayment"
  | "justification"
  | "legislationDocument"
  | "legislationIndexJob"
  | "legislationSource"
  | "softLawSource"
  | "softLawDocument"
  | "softLawDocumentVersion"
  | "softLawDocumentLocator"
  | "softLawIngestionLease"
  | "softLawIngestionAttempt"
  | "legislationWorkName"
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
  | "legalReaderAnnotation"
  | "legalReaderAnswer"
  | "legalReaderAnswerMessage"
  | "matter"
  | "matterCounter"
  | "mcpConnector"
  | "mcpOAuthClient"
  | "mcpUserConnection"
  | "notification"
  | "organization"
  | "organizationSettings"
  | "pdfSigningSession"
  | "pendingUpload"
  | "playbook"
  | "playbookDefinition"
  | "playbookDefinitionVersion"
  | "property"
  | "propertyDependency"
  | "rateEntry"
  | "rateTable"
  | "sanctionsEdition"
  | "sanctionsScreeningEvent"
  | "savedSearch"
  | "searchHistoryEntry"
  | "vatRate"
  | "sellerProfile"
  | "numberSeries"
  | "reportExport"
  | "schedulerJobRun"
  | "sharepointConnection"
  | "sharepointOAuthState"
  | "styleSet"
  | "taskAssignee"
  | "task"
  | "template"
  | "templateCategory"
  | "templateLookupFormat"
  | "templateClause"
  | "templateRecipe"
  | "templateFill"
  | "templatePersistenceRequest"
  | "templateVersion"
  | "timeEntry"
  | "timeEntrySuggestion"
  | "timeTimer"
  | "user"
  | "userFile"
  | "workspace"
  | "workspaceContact"
  | "workspaceMember"
  | "workspaceView"
  | "workspaceViewTemplate"
  | "workObligationEvent"
  | "entityLink";

export const isSafeIdValue = (value: string): boolean =>
  value.length > 0 && value.isWellFormed();

/**
 * The one validator behind every brander: a consumer that narrows the id set
 * (the api closes `SafeIdType`) parses with this schema rather than restating
 * the check and its message.
 */
/**
 * A user id as the auth provider issues it: an opaque string, not a UUID, so
 * every input that names a person accepts the same shape.
 */
export const userIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
);

export const safeIdSchema = v.pipe(
  v.string(),
  v.check(isSafeIdValue, "Expected a non-empty, well-formed identifier"),
  v.brand("SafeId"),
);

/**
 * Portable compile-time identifier brand. Runtime validation belongs to the
 * boundary that owns each identifier; the type parameter prevents IDs from
 * different domains being exchanged accidentally inside typed code.
 */
export type SafeId<TType extends string> = v.InferOutput<
  typeof safeIdSchema
> & {
  readonly __safeIdType?: TType;
};

/** Brand an identifier at a boundary that has already established its source. */
export const toSafeId = <TType extends string>(value: string): SafeId<TType> =>
  v.parse(safeIdSchema, value);

import type { ENUM_COLUMNS } from "@/api/lib/db/status-tables.gen";

/**
 * What an enum-valued column is to its row. A lifecycle column moves between
 * its values over the row's life and joins the status inventory, so its writes
 * go through the transition owner; an attribute is a fact about the row.
 */
export const ENUM_COLUMN_ROLE = {
  lifecycle: "lifecycle",
  attribute: "attribute",
} as const;

export type EnumColumnRole =
  (typeof ENUM_COLUMN_ROLE)[keyof typeof ENUM_COLUMN_ROLE];

const LIFECYCLE = ENUM_COLUMN_ROLE.lifecycle;
const ATTRIBUTE = ENUM_COLUMN_ROLE.attribute;

// Total over every enum-valued table column whose name does not already mark
// it as a lifecycle: a new one fails to compile until it is classified here.
type EnumColumnRoles = {
  readonly [TTable in keyof typeof ENUM_COLUMNS]: Readonly<
    Record<(typeof ENUM_COLUMNS)[TTable][number], EnumColumnRole>
  >;
};

export const ENUM_COLUMN_ROLES = {
  accountAuditLogs: {
    eventType: ATTRIBUTE,
  },
  accountExports: {
    kind: ATTRIBUTE,
  },
  agentSkills: {
    invocation: ATTRIBUTE,
    origin: ATTRIBUTE,
    scope: ATTRIBUTE,
  },
  aiMemories: {
    kind: ATTRIBUTE,
    scope: ATTRIBUTE,
    source: ATTRIBUTE,
  },
  anonymizationAllowlistEntries: {
    entityFeatureGate: ATTRIBUTE,
  },
  auditLogs: {
    activityCategory: ATTRIBUTE,
    performerType: ATTRIBUTE,
    triggerType: ATTRIBUTE,
  },
  bilingualTranslationRows: {
    disposition: ATTRIBUTE,
    dispositionOrigin: ATTRIBUTE,
    kind: ATTRIBUTE,
    tableLayout: ATTRIBUTE,
  },
  billingArrangements: {
    mode: ATTRIBUTE,
  },
  billingCodes: {
    type: ATTRIBUTE,
  },
  businessRegistryCredentials: {
    registry: ATTRIBUTE,
  },
  caseLawAnalysisFailures: {
    code: ATTRIBUTE,
    keySource: ATTRIBUTE,
  },
  caseLawBrowseFacetCounts: {
    kind: ATTRIBUTE,
  },
  caseLawCitationDoctrineReviews: {
    doctrinalTreatment: ATTRIBUTE,
    origin: ATTRIBUTE,
  },
  caseLawCitationResolutionCensus: {
    kind: ATTRIBUTE,
  },
  caseLawCitationReviews: {
    origin: ATTRIBUTE,
  },
  caseLawCitations: {
    doctrinalTreatment: ATTRIBUTE,
  },
  caseLawCorpusPackRefs: {
    kind: ATTRIBUTE,
  },
  caseLawCorpusTombstones: {
    reason: ATTRIBUTE,
  },
  caseLawDecisionCitationStats: {
    direction: ATTRIBUTE,
    polarity: ATTRIBUTE,
  },
  caseLawDecisionJudges: {
    role: ATTRIBUTE,
  },
  caseLawDecisions: {
    caseNumberType: ATTRIBUTE,
  },
  caseLawPopulationCounts: {
    kind: ATTRIBUTE,
  },
  caseLawPopulationDeltas: {
    kind: ATTRIBUTE,
  },
  caseLawPopulationProjections: {
    publication: ATTRIBUTE,
  },
  caseLawProvisionCitations: {
    appliedVersionBasis: ATTRIBUTE,
    appliedVersionDateRelation: ATTRIBUTE,
    selection: ATTRIBUTE,
    spanRole: ATTRIBUTE,
    unit: ATTRIBUTE,
    versionEvidenceKind: ATTRIBUTE,
    workSource: ATTRIBUTE,
  },
  caseLawProvisionExtractions: {
    enqueueReason: ATTRIBUTE,
    lane: ATTRIBUTE,
    outcome: ATTRIBUTE,
    payloadClass: ATTRIBUTE,
    terminalReason: ATTRIBUTE,
  },
  caseLawProvisionRepairCursors: {
    name: ATTRIBUTE,
  },
  caseLawProvisionScopeTransitions: {
    action: ATTRIBUTE,
  },
  caseLawRemovalReconciliationItems: {
    kind: ATTRIBUTE,
  },
  caseLawReplayAuditEvents: {
    action: ATTRIBUTE,
  },
  caseLawReplayBatches: {
    failureCode: ATTRIBUTE,
  },
  caseLawReplayBlocked: {
    outcome: ATTRIBUTE,
    reason: ATTRIBUTE,
  },
  caseLawResearchAnswers: {
    failureReason: ATTRIBUTE,
  },
  caseLawSources: {
    ingestionLeasePurpose: ATTRIBUTE,
  },
  caseLawStatuteCitationCounts: {
    targetType: ATTRIBUTE,
  },
  caseLawStatuteCitationMemberships: {
    targetType: ATTRIBUTE,
  },
  cellMetadata: {
    entityFeatureGate: ATTRIBUTE,
  },
  chatContentV3BackfillReceipts: {
    outcome: ATTRIBUTE,
    source: ATTRIBUTE,
  },
  chatSecrets: {
    decision: ATTRIBUTE,
  },
  chatThreads: {
    chatReasoningEffort: ATTRIBUTE,
  },
  chatToolGrants: {
    scope: ATTRIBUTE,
  },
  chatTurns: {
    cancellationReason: ATTRIBUTE,
    failureCode: ATTRIBUTE,
    interactionType: ATTRIBUTE,
    interruptionReason: ATTRIBUTE,
  },
  contactRelationships: {
    relationshipType: ATTRIBUTE,
  },
  contactSearchDocuments: {
    contactType: ATTRIBUTE,
  },
  contacts: {
    invoiceLanguage: ATTRIBUTE,
    sanctionsMonitoringMode: ATTRIBUTE,
    timeBillingFormat: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  corpusIndexGenerations: {
    family: ATTRIBUTE,
  },
  corpusIndexGroupEnrollments: {
    contractVersion: ATTRIBUTE,
    family: ATTRIBUTE,
  },
  corpusIndexGroupWithdrawals: {
    family: ATTRIBUTE,
  },
  corpusIndexJurisdictionServing: {
    family: ATTRIBUTE,
  },
  corpusIndexProjectionIntents: {
    family: ATTRIBUTE,
  },
  corpusIndexProjectionRevisions: {
    family: ATTRIBUTE,
  },
  corpusIndexProjectionStates: {
    appendMode: ATTRIBUTE,
    appliedAction: ATTRIBUTE,
    desiredAction: ATTRIBUTE,
    family: ATTRIBUTE,
    lastFailureKind: ATTRIBUTE,
  },
  correspondence: {
    channel: ATTRIBUTE,
    direction: ATTRIBUTE,
    dkim: ATTRIBUTE,
    dmarc: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
    intake: ATTRIBUTE,
    source: ATTRIBUTE,
    spf: ATTRIBUTE,
  },
  correspondenceAllowedSenders: {
    kind: ATTRIBUTE,
    scope: ATTRIBUTE,
  },
  correspondenceAttachments: {
    entityFeatureGate: ATTRIBUTE,
    scanVerdict: ATTRIBUTE,
  },
  correspondenceDropLogs: {
    reason: ATTRIBUTE,
  },
  correspondenceFilers: {
    entityFeatureGate: ATTRIBUTE,
  },
  correspondenceSources: {
    entityFeatureGate: ATTRIBUTE,
  },
  desktopEditHandoffs: {
    entityFeatureGate: ATTRIBUTE,
    failureReason: ATTRIBUTE,
  },
  desktopEditSessions: {
    entityFeatureGate: ATTRIBUTE,
    fileType: ATTRIBUTE,
  },
  desktopRunnerCommands: {
    kind: ATTRIBUTE,
  },
  desktopRunnerEvents: {
    type: ATTRIBUTE,
  },
  desktopRunnerRuns: {
    harness: ATTRIBUTE,
    outcome: ATTRIBUTE,
    rejectReason: ATTRIBUTE,
  },
  desktopRunners: {
    connection: LIFECYCLE,
  },
  documentProcessingRuns: {
    entityFeatureGate: ATTRIBUTE,
    kind: ATTRIBUTE,
    requestSource: ATTRIBUTE,
  },
  documentReviewFindings: {
    decision: ATTRIBUTE,
    flags: ATTRIBUTE,
  },
  documentReviewParties: {
    entityFeatureGate: ATTRIBUTE,
  },
  documentReviewReferencePassages: {
    entityFeatureGate: ATTRIBUTE,
  },
  documentReviewRuns: {
    executor: ATTRIBUTE,
  },
  documentTranslationRuns: {
    commentPolicy: ATTRIBUTE,
    engine: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
    output: ATTRIBUTE,
  },
  documentTranslationUnits: {
    entityFeatureGate: ATTRIBUTE,
  },
  docxSuggestions: {
    appliedMode: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
    severity: ATTRIBUTE,
  },
  entities: {
    agendaKind: ATTRIBUTE,
    agendaSource: ATTRIBUTE,
    availability: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
    kind: ATTRIBUTE,
    listItemType: ATTRIBUTE,
    sensitivity: ATTRIBUTE,
  },
  entityLinks: {
    entityFeatureGate: ATTRIBUTE,
  },
  entityVersionAiSummaries: {
    entityFeatureGate: ATTRIBUTE,
  },
  entityVersions: {
    entityFeatureGate: ATTRIBUTE,
  },
  euCompletionReceipts: {
    mode: ATTRIBUTE,
    target: ATTRIBUTE,
  },
  expenses: {
    category: ATTRIBUTE,
  },
  extractedContent: {
    entityFeatureGate: ATTRIBUTE,
  },
  extractionRuns: {
    scope: ATTRIBUTE,
  },
  feedbackReports: {
    area: ATTRIBUTE,
    kind: ATTRIBUTE,
    via: ATTRIBUTE,
  },
  fields: {
    entityFeatureGate: ATTRIBUTE,
  },
  fileChatThreads: {
    entityFeatureGate: ATTRIBUTE,
  },
  fileComparisonUploads: {
    kind: ATTRIBUTE,
  },
  flowRunSteps: {
    entityFeatureGate: ATTRIBUTE,
  },
  folioCollabContributions: {
    entityFeatureGate: ATTRIBUTE,
  },
  folioCollabPublications: {
    entityFeatureGate: ATTRIBUTE,
  },
  folioCollabRoomTokens: {
    entityFeatureGate: ATTRIBUTE,
  },
  folioCollabRooms: {
    entityFeatureGate: ATTRIBUTE,
  },
  hostedUsageWebhookEvents: {
    result: LIFECYCLE,
  },
  invoiceLines: {
    billingPurpose: ATTRIBUTE,
    source: ATTRIBUTE,
    vatTreatment: ATTRIBUTE,
  },
  invoicePayments: {
    method: ATTRIBUTE,
    origin: ATTRIBUTE,
  },
  invoices: {
    billingMode: ATTRIBUTE,
    documentType: ATTRIBUTE,
    language: ATTRIBUTE,
  },
  justifications: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListClaimReviewEvents: {
    entityFeatureGate: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  legalListClaims: {
    entityFeatureGate: ATTRIBUTE,
    framing: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  legalListFactDetails: {
    confidence: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
    occurredOnPrecision: ATTRIBUTE,
    scoring: ATTRIBUTE,
  },
  legalListGenerationCandidateSources: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListGenerationCandidates: {
    entityFeatureGate: ATTRIBUTE,
    itemType: ATTRIBUTE,
    priority: ATTRIBUTE,
  },
  legalListGenerationSources: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListItemComments: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListItemReviews: {
    decision: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
  },
  legalListItemSourceDecisions: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListItemSources: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListItems: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListVerificationBlocks: {
    entityFeatureGate: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  legalListVerificationReadReceipts: {
    entityFeatureGate: ATTRIBUTE,
  },
  legalListVerificationRuns: {
    entityFeatureGate: ATTRIBUTE,
    errorCode: ATTRIBUTE,
  },
  legalReaderAnnotations: {
    color: ATTRIBUTE,
    kind: ATTRIBUTE,
    style: ATTRIBUTE,
    targetType: ATTRIBUTE,
    visibility: ATTRIBUTE,
  },
  legalReaderAnswerMessages: {
    role: ATTRIBUTE,
  },
  legalReaderAnswers: {
    kind: ATTRIBUTE,
    visibility: ATTRIBUTE,
  },
  legislationAmendments: {
    changeKind: ATTRIBUTE,
    effectiveType: ATTRIBUTE,
  },
  legislationDocuments: {
    expressionKind: ATTRIBUTE,
    identityMode: ATTRIBUTE,
    windowDisposition: ATTRIBUTE,
  },
  legislationSources: {
    identityMode: ATTRIBUTE,
  },
  legislationWorkNames: {
    derivation: ATTRIBUTE,
  },
  mcpConnectors: {
    authType: ATTRIBUTE,
  },
  mcpUserConnections: {
    responseDisposition: ATTRIBUTE,
  },
  mcpWebHandoff: {
    kind: ATTRIBUTE,
  },
  notifications: {
    entityType: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  numberSeries: {
    documentType: ATTRIBUTE,
  },
  numberSeriesAllocations: {
    documentType: ATTRIBUTE,
  },
  oauthClient: {
    registrationOrigin: ATTRIBUTE,
  },
  officeFileEvidence: {
    entityFeatureGate: ATTRIBUTE,
    format: ATTRIBUTE,
  },
  organizationAccessStates: {
    origin: ATTRIBUTE,
  },
  organizationSettings: {
    aiBillingDraftsMode: ATTRIBUTE,
    documentProcessingMode: ATTRIBUTE,
    invoiceLanguage: ATTRIBUTE,
    managedAIResidency: ATTRIBUTE,
    personalApiKeyPolicy: ATTRIBUTE,
    sanctionsMonitoringMode: ATTRIBUTE,
  },
  pdfSigningSessions: {
    closeReason: ATTRIBUTE,
    entityFeatureGate: ATTRIBUTE,
    keyType: ATTRIBUTE,
  },
  pendingUploads: {
    purpose: ATTRIBUTE,
  },
  pushDevices: {
    bundleId: ATTRIBUTE,
    environment: ATTRIBUTE,
  },
  rateEntries: {
    role: ATTRIBUTE,
  },
  registrationDailyBudget: {
    kind: ATTRIBUTE,
  },
  reportExports: {
    entityFeatureGate: ATTRIBUTE,
    format: ATTRIBUTE,
    mode: ATTRIBUTE,
  },
  sanctionsContactMatches: {
    disposition: ATTRIBUTE,
  },
  sanctionsEditions: {
    guardCode: ATTRIBUTE,
  },
  sanctionsScreeningEvents: {
    type: ATTRIBUTE,
  },
  sanctionsSources: {
    heldGuardCode: ATTRIBUTE,
    lastFailureCode: ATTRIBUTE,
  },
  searchDocumentPreviewPassages: {
    entityFeatureGate: ATTRIBUTE,
  },
  searchDocuments: {
    entityFeatureGate: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  searchHistoryEntries: {
    kind: ATTRIBUTE,
  },
  searchHistoryTombstones: {
    kind: ATTRIBUTE,
  },
  searchProjectionRepairQueue: {
    kind: ATTRIBUTE,
  },
  session: {
    refreshMode: ATTRIBUTE,
  },
  signalEvents: {
    type: ATTRIBUTE,
  },
  signals: {
    kind: ATTRIBUTE,
    origin: ATTRIBUTE,
    severity: ATTRIBUTE,
  },
  softLawDocumentVersions: {
    extractionQuality: ATTRIBUTE,
  },
  softLawDocuments: {
    kind: ATTRIBUTE,
    validityBasis: ATTRIBUTE,
  },
  softLawIngestionAttempts: {
    tag: ATTRIBUTE,
  },
  softLawSources: {
    failureTag: ATTRIBUTE,
  },
  taskAssignees: {
    entityFeatureGate: ATTRIBUTE,
    role: ATTRIBUTE,
  },
  templateLookupFormatUserDefaults: {
    registry: ATTRIBUTE,
  },
  templateLookupFormats: {
    preference: ATTRIBUTE,
    registry: ATTRIBUTE,
  },
  templates: {
    kind: ATTRIBUTE,
    originType: ATTRIBUTE,
  },
  timeEntries: {
    activityGroup: ATTRIBUTE,
    invoiceAttachment: ATTRIBUTE,
    source: ATTRIBUTE,
  },
  timerActivityDevices: {
    bundleId: ATTRIBUTE,
    environment: ATTRIBUTE,
  },
  usageAllocations: {
    reason: ATTRIBUTE,
    sourceType: ATTRIBUTE,
  },
  usageEntitlements: {
    source: ATTRIBUTE,
  },
  usageEvents: {
    actionType: ATTRIBUTE,
    lane: ATTRIBUTE,
    serviceTier: ATTRIBUTE,
  },
  usageLaneCounters: {
    kind: ATTRIBUTE,
  },
  usagePolicies: {
    billingInterval: ATTRIBUTE,
    kind: ATTRIBUTE,
    priceBasis: ATTRIBUTE,
    visibility: ATTRIBUTE,
  },
  user: {
    readerAnswerLanguage: ATTRIBUTE,
  },
  userProfessionalUseAcceptances: {
    source: ATTRIBUTE,
  },
  workObligationEvents: {
    entityFeatureGate: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  workObligations: {
    entityFeatureGate: ATTRIBUTE,
    sourceType: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  workspaceContacts: {
    role: ATTRIBUTE,
  },
} as const satisfies EnumColumnRoles;

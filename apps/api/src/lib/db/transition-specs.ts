import { FLOW_RUN_TRANSITIONS_V1 } from "@/api/lib/db/flow-run-transition-spec";
import type { StatusTable } from "@/api/lib/db/status-tables.gen";
import type { TransitionSpec } from "@/api/lib/db/transitions";

/** Existing domain owners remain explicit until their writers migrate. */
export const TRANSITIONS = {
  agentRegistration: {
    unmanaged:
      "Registration lifecycle remains owned by the authentication ceremony store.",
  },
  accountDeletionEffectChunks: {
    unmanaged:
      "Existing accountDeletionEffectChunks writers have not migrated to the transition owner.",
  },
  accountDeletionRequests: {
    unmanaged:
      "Existing accountDeletionRequests writers have not migrated to the transition owner.",
  },
  agentSkillProposals: {
    unmanaged:
      "Existing agentSkillProposals writers have not migrated to the transition owner.",
  },
  aiMemories: {
    unmanaged:
      "Existing aiMemories writers have not migrated to the transition owner.",
  },
  auditLogs: {
    unmanaged:
      "Existing auditLogs writers have not migrated to the transition owner.",
  },
  bilingualTranslationRows: {
    unmanaged:
      "Existing bilingualTranslationRows writers have not migrated to the transition owner.",
  },
  bilingualTranslationRuns: {
    unmanaged:
      "Existing bilingualTranslationRuns writers have not migrated to the transition owner.",
  },
  billingArrangements: {
    unmanaged:
      "Existing billingArrangements writers have not migrated to the transition owner.",
  },
  bufferObjectCleanupIntents: {
    unmanaged:
      "Existing bufferObjectCleanupIntents writers have not migrated to the transition owner.",
  },
  caseLawCitationResolutionCensusRuns: {
    unmanaged:
      "Existing caseLawCitationResolutionCensusRuns writers have not migrated to the transition owner.",
  },
  caseLawCitations: {
    unmanaged:
      "Existing caseLawCitations writers have not migrated to the transition owner.",
  },
  caseLawCorpusUploadIntents: {
    unmanaged:
      "Existing caseLawCorpusUploadIntents writers have not migrated to the transition owner.",
  },
  caseLawDecisionIdentifierBackfills: {
    unmanaged:
      "Existing caseLawDecisionIdentifierBackfills writers have not migrated to the transition owner.",
  },
  caseLawDecisions: {
    unmanaged:
      "Existing caseLawDecisions writers have not migrated to the transition owner.",
  },
  caseLawIndexJobs: {
    unmanaged:
      "Existing caseLawIndexJobs writers have not migrated to the transition owner.",
  },
  caseLawIngestionEvents: {
    unmanaged:
      "Existing caseLawIngestionEvents writers have not migrated to the transition owner.",
  },
  caseLawProvisionCitations: {
    unmanaged:
      "Existing caseLawProvisionCitations writers have not migrated to the transition owner.",
  },
  caseLawProvisionExtractions: {
    unmanaged:
      "Existing caseLawProvisionExtractions writers have not migrated to the transition owner.",
  },
  caseLawProvisionExtractionScopes: {
    unmanaged:
      "Existing caseLawProvisionExtractionScopes writers have not migrated to the transition owner.",
  },
  caseLawReconciliationItems: {
    unmanaged:
      "Existing caseLawReconciliationItems writers have not migrated to the transition owner.",
  },
  caseLawResearchAnswers: {
    unmanaged:
      "Existing caseLawResearchAnswers writers have not migrated to the transition owner.",
  },
  caseLawSearchBackfillFailures: {
    unmanaged:
      "Existing caseLawSearchBackfillFailures writers have not migrated to the transition owner.",
  },
  caseLawStatuteCitationCountState: {
    unmanaged:
      "Existing caseLawStatuteCitationCountState writers have not migrated to the transition owner.",
  },
  chatThreadCompactions: {
    unmanaged:
      "Existing chatThreadCompactions writers have not migrated to the transition owner.",
  },
  chatTurns: {
    unmanaged:
      "Existing chatTurns writers have not migrated to the transition owner.",
  },
  contactExtractionUploads: {
    unmanaged:
      "Existing contactExtractionUploads writers have not migrated to the transition owner.",
  },
  corpusIndexGenerations: {
    unmanaged:
      "Existing corpusIndexGenerations writers have not migrated to the transition owner.",
  },
  corpusIndexGroupEnrollments: {
    unmanaged:
      "Existing corpusIndexGroupEnrollments writers have not migrated to the transition owner.",
  },
  corpusIndexProjectionIntents: {
    unmanaged:
      "Existing corpusIndexProjectionIntents writers have not migrated to the transition owner.",
  },
  corpusIndexProjectionStates: {
    unmanaged:
      "Existing corpusIndexProjectionStates writers have not migrated to the transition owner.",
  },
  correspondence: {
    unmanaged:
      "Existing correspondence writers have not migrated to the transition owner.",
  },
  desktopEditSessions: {
    unmanaged:
      "Existing desktopEditSessions writers have not migrated to the transition owner.",
  },
  documentProcessingRuns: {
    unmanaged:
      "Existing documentProcessingRuns writers have not migrated to the transition owner.",
  },
  documentReviewFindings: {
    unmanaged:
      "Existing documentReviewFindings writers have not migrated to the transition owner.",
  },
  documentReviewRuns: {
    unmanaged:
      "Existing documentReviewRuns writers have not migrated to the transition owner.",
  },
  documentTranslationRuns: {
    unmanaged:
      "Existing documentTranslationRuns writers have not migrated to the transition owner.",
  },
  documentTranslationUnits: {
    unmanaged:
      "Existing documentTranslationUnits writers have not migrated to the transition owner.",
  },
  docxSuggestions: {
    unmanaged:
      "Existing docxSuggestions writers have not migrated to the transition owner.",
  },
  entities: {
    unmanaged:
      "Existing entities writers have not migrated to the transition owner.",
  },
  entityDeletionCleanupRequests: {
    unmanaged:
      "Existing entityDeletionCleanupRequests writers have not migrated to the transition owner.",
  },
  entityDeletionEffectChunks: {
    unmanaged:
      "Existing entityDeletionEffectChunks writers have not migrated to the transition owner.",
  },
  expenses: {
    unmanaged:
      "Existing expenses writers have not migrated to the transition owner.",
  },
  extractionRuns: {
    unmanaged:
      "Existing extractionRuns writers have not migrated to the transition owner.",
  },
  fileComparisonUploads: {
    unmanaged:
      "Existing fileComparisonUploads writers have not migrated to the transition owner.",
  },
  flowRuns: FLOW_RUN_TRANSITIONS_V1,
  flowRunSteps: {
    unmanaged:
      "Existing flowRunSteps writers have not migrated to the transition owner.",
  },
  folioCollabRooms: {
    unmanaged:
      "Existing folioCollabRooms writers have not migrated to the transition owner.",
  },
  invitation: {
    unmanaged: "Invitation acceptance and expiry remain owned by Better Auth.",
  },
  invoices: {
    unmanaged:
      "Existing invoices writers have not migrated to the transition owner.",
  },
  legalListClaims: {
    unmanaged:
      "Existing legalListClaims writers have not migrated to the transition owner.",
  },
  legalListGenerationCandidates: {
    unmanaged:
      "Existing legalListGenerationCandidates writers have not migrated to the transition owner.",
  },
  legalListGenerationRuns: {
    unmanaged:
      "Existing legalListGenerationRuns writers have not migrated to the transition owner.",
  },
  legalListItems: {
    unmanaged:
      "Existing legalListItems writers have not migrated to the transition owner.",
  },
  legalListItemSources: {
    unmanaged:
      "Existing legalListItemSources writers have not migrated to the transition owner.",
  },
  legalLists: {
    unmanaged:
      "Existing legalLists writers have not migrated to the transition owner.",
  },
  legalListVerificationRuns: {
    unmanaged:
      "Existing legalListVerificationRuns writers have not migrated to the transition owner.",
  },
  legislationDocuments: {
    unmanaged:
      "Existing legislationDocuments writers have not migrated to the transition owner.",
  },
  legislationIndexJobs: {
    unmanaged:
      "Existing legislationIndexJobs writers have not migrated to the transition owner.",
  },
  mcpOAuthState: {
    unmanaged: "State holds an OAuth anti-forgery token, not a lifecycle.",
  },
  mcpUserConnections: {
    unmanaged:
      "Existing mcpUserConnections writers have not migrated to the transition owner.",
  },
  officeFileEvidence: {
    unmanaged:
      "Existing officeFileEvidence writers have not migrated to the transition owner.",
  },
  organizationAccessStates: {
    unmanaged:
      "Existing organizationAccessStates writers have not migrated to the transition owner.",
  },
  organizationConfiguredAccess: {
    unmanaged:
      "Existing organizationConfiguredAccess writers have not migrated to the transition owner.",
  },
  organizationFileObjects: {
    unmanaged:
      "Existing organizationFileObjects writers have not migrated to the transition owner.",
  },
  pdfSigningSessions: {
    unmanaged:
      "Existing pdfSigningSessions writers have not migrated to the transition owner.",
  },
  pendingUploads: {
    unmanaged:
      "Existing pendingUploads writers have not migrated to the transition owner.",
  },
  playbookDefinitions: {
    unmanaged:
      "Existing playbookDefinitions writers have not migrated to the transition owner.",
  },
  properties: {
    unmanaged:
      "Existing properties writers have not migrated to the transition owner.",
  },
  reportExports: {
    unmanaged:
      "Existing reportExports writers have not migrated to the transition owner.",
  },
  sanctionsEditions: {
    unmanaged:
      "Existing sanctionsEditions writers have not migrated to the transition owner.",
  },
  schedulerJobRuns: {
    unmanaged:
      "Existing schedulerJobRuns writers have not migrated to the transition owner.",
  },
  scoutRuns: {
    unmanaged:
      "Existing scoutRuns writers have not migrated to the transition owner.",
  },
  sharepointConnections: {
    unmanaged:
      "Existing sharepointConnections writers have not migrated to the transition owner.",
  },
  sharepointOAuthState: {
    unmanaged: "State holds an OAuth anti-forgery token, not a lifecycle.",
  },
  signals: {
    unmanaged:
      "Existing signals writers have not migrated to the transition owner.",
  },
  styleSets: {
    unmanaged:
      "Existing styleSets writers have not migrated to the transition owner.",
  },
  templateDeletionCleanupRequests: {
    unmanaged:
      "Existing templateDeletionCleanupRequests writers have not migrated to the transition owner.",
  },
  templateFills: {
    unmanaged:
      "Existing templateFills writers have not migrated to the transition owner.",
  },
  templatePersistenceRequests: {
    unmanaged:
      "Existing templatePersistenceRequests writers have not migrated to the transition owner.",
  },
  templates: {
    unmanaged:
      "Existing templates writers have not migrated to the transition owner.",
  },
  templateVersions: {
    unmanaged:
      "Existing templateVersions writers have not migrated to the transition owner.",
  },
  timeEntries: {
    unmanaged:
      "Existing timeEntries writers have not migrated to the transition owner.",
  },
  timeEntrySuggestions: {
    unmanaged:
      "Existing timeEntrySuggestions writers have not migrated to the transition owner.",
  },
  timeEntryTimerStates: {
    unmanaged:
      "Existing timeEntryTimerStates writers have not migrated to the transition owner.",
  },
  timeTimers: {
    unmanaged:
      "Existing timeTimers writers have not migrated to the transition owner.",
  },
  usageEntitlements: {
    unmanaged:
      "Existing usageEntitlements writers have not migrated to the transition owner.",
  },
  workObligations: {
    unmanaged:
      "Existing workObligations writers have not migrated to the transition owner.",
  },
  workspaces: {
    unmanaged:
      "Existing workspaces writers have not migrated to the transition owner.",
  },
} as const satisfies Record<
  StatusTable,
  TransitionSpec | { unmanaged: string }
>;

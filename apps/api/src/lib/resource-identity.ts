import { RESOURCE_TYPE } from "@stll/api-contract";
import type { ResourceType } from "@stll/api-contract";

import type { SafeIdType } from "@/api/lib/branded-types";

type NonResourceReason =
  | "association"
  | "collaboration"
  | "credential"
  | "event"
  | "job"
  | "policy"
  | "projection"
  | "session"
  | "singleton"
  | "subresource"
  | "workflow";

type IdentityDisposition =
  | { type: "resource"; resourceType: ResourceType }
  | { type: "alias"; resourceType: ResourceType }
  | { type: "non_resource"; reason: NonResourceReason };

/**
 * Total census of Stella's branded IDs. A branded database identifier is not
 * automatically a product resource; additions must make that decision here.
 */
export const RESOURCE_IDENTITY_DISPOSITION = {
  accountDeletionRequest: { type: "non_resource", reason: "workflow" },
  agentSkill: { type: "resource", resourceType: RESOURCE_TYPE.AGENT_SKILL },
  agentSkillComment: {
    type: "resource",
    resourceType: RESOURCE_TYPE.AGENT_SKILL_COMMENT,
  },
  agentSkillProposal: {
    type: "resource",
    resourceType: RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
  },
  agentSkillResource: {
    type: "resource",
    resourceType: RESOURCE_TYPE.AGENT_SKILL_RESOURCE,
  },
  agentSkillRevision: {
    type: "resource",
    resourceType: RESOURCE_TYPE.AGENT_SKILL_REVISION,
  },
  aiMemory: { type: "resource", resourceType: RESOURCE_TYPE.AI_MEMORY },
  anonymizationAllowlistEntry: {
    type: "non_resource",
    reason: "subresource",
  },
  anonymizationBlacklistEntry: {
    type: "non_resource",
    reason: "subresource",
  },
  auditLog: { type: "non_resource", reason: "event" },
  billingCode: {
    type: "resource",
    resourceType: RESOURCE_TYPE.BILLING_CODE,
  },
  caseLawCitation: { type: "non_resource", reason: "association" },
  caseLawCitationResolutionCensusRun: {
    type: "non_resource",
    reason: "projection",
  },
  caseLawCoverageSlice: { type: "non_resource", reason: "projection" },
  caseLawCourtWeight: { type: "non_resource", reason: "policy" },
  caseLawDecision: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CASE_LAW_DECISION,
  },
  caseLawDecisionAnnotation: { type: "non_resource", reason: "subresource" },
  caseLawCorpusUploadIntent: { type: "non_resource", reason: "workflow" },
  caseLawIndexJob: { type: "non_resource", reason: "job" },
  caseLawIngestionEvent: { type: "non_resource", reason: "event" },
  caseLawIngestionFailure: { type: "non_resource", reason: "event" },
  caseLawMatterLink: { type: "non_resource", reason: "association" },
  caseLawPolarityRule: { type: "non_resource", reason: "policy" },
  caseLawProvisionCitation: { type: "non_resource", reason: "association" },
  caseLawReconciliationItem: { type: "non_resource", reason: "workflow" },
  caseLawSource: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CASE_LAW_SOURCE,
  },
  caseLawSourceIngestionLease: { type: "non_resource", reason: "job" },
  chatMessage: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CHAT_MESSAGE,
  },
  chatTurn: { type: "non_resource", reason: "workflow" },
  chatThreadCompaction: { type: "non_resource", reason: "projection" },
  chatThread: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CHAT_THREAD,
  },
  fileChatThread: { type: "non_resource", reason: "association" },
  templateChatThread: { type: "non_resource", reason: "association" },
  templateDeletionCleanupRequest: { type: "non_resource", reason: "job" },
  clause: { type: "resource", resourceType: RESOURCE_TYPE.CLAUSE },
  clauseCategory: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CLAUSE_CATEGORY,
  },
  clauseVariant: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CLAUSE_VARIANT,
  },
  clauseVersion: {
    type: "resource",
    resourceType: RESOURCE_TYPE.CLAUSE_VERSION,
  },
  contact: { type: "resource", resourceType: RESOURCE_TYPE.CONTACT },
  contactExtractionUpload: { type: "non_resource", reason: "workflow" },
  contactImportRequest: { type: "non_resource", reason: "workflow" },
  contactRelationship: { type: "non_resource", reason: "association" },
  corpusIndexProjectionIntent: { type: "non_resource", reason: "workflow" },
  usageAllocation: { type: "non_resource", reason: "policy" },
  usageLaneCounter: { type: "non_resource", reason: "event" },
  usageSeatAssignment: { type: "non_resource", reason: "policy" },
  usagePolicy: { type: "non_resource", reason: "policy" },
  usageEntitlement: { type: "non_resource", reason: "policy" },
  usageEvent: { type: "non_resource", reason: "event" },
  desktopEditHandoff: { type: "non_resource", reason: "workflow" },
  desktopEditSession: { type: "non_resource", reason: "session" },
  docxSuggestion: { type: "non_resource", reason: "subresource" },
  document: { type: "alias", resourceType: RESOURCE_TYPE.ENTITY },
  documentCounter: { type: "non_resource", reason: "projection" },
  entityDeletionCleanupRequest: { type: "non_resource", reason: "job" },
  accountDeletionEffectChunk: { type: "non_resource", reason: "job" },
  entityDeletionEffectChunk: { type: "non_resource", reason: "job" },
  effectLease: { type: "non_resource", reason: "job" },
  documentProcessingRun: { type: "non_resource", reason: "job" },
  // A review run is background execution provenance, like `extractionRun` and
  // `documentProcessingRun`; a finding is only ever addressed through the run
  // that produced it, so it is that run's subresource rather than a noun.
  bilingualTranslationRow: { type: "non_resource", reason: "subresource" },
  bilingualTranslationRun: { type: "non_resource", reason: "job" },
  documentTranslationRun: { type: "non_resource", reason: "job" },
  documentTranslationUnit: { type: "non_resource", reason: "subresource" },
  documentReviewFinding: { type: "non_resource", reason: "subresource" },
  documentReviewRun: { type: "non_resource", reason: "job" },
  documentType: {
    type: "resource",
    resourceType: RESOURCE_TYPE.DOCUMENT_TYPE,
  },
  entity: { type: "resource", resourceType: RESOURCE_TYPE.ENTITY },
  entityVersionAiSummary: { type: "non_resource", reason: "projection" },
  entityVersion: {
    type: "resource",
    resourceType: RESOURCE_TYPE.ENTITY_VERSION,
  },
  expense: { type: "resource", resourceType: RESOURCE_TYPE.EXPENSE },
  extractionRun: { type: "non_resource", reason: "job" },
  field: { type: "resource", resourceType: RESOURCE_TYPE.FIELD },
  flowDefinition: {
    type: "resource",
    resourceType: RESOURCE_TYPE.FLOW_DEFINITION,
  },
  flowRun: { type: "resource", resourceType: RESOURCE_TYPE.FLOW_RUN },
  flowRunStep: { type: "non_resource", reason: "subresource" },
  folioCollabRoom: { type: "non_resource", reason: "collaboration" },
  folioCollabRoomToken: { type: "non_resource", reason: "credential" },
  folder: { type: "alias", resourceType: RESOURCE_TYPE.ENTITY },
  infoSoudTrackedCase: { type: "non_resource", reason: "workflow" },
  invoice: { type: "resource", resourceType: RESOURCE_TYPE.INVOICE },
  justification: { type: "non_resource", reason: "subresource" },
  legislationDocument: {
    type: "resource",
    resourceType: RESOURCE_TYPE.LEGISLATION_DOCUMENT,
  },
  legislationIndexJob: { type: "non_resource", reason: "job" },
  legislationSource: {
    type: "resource",
    resourceType: RESOURCE_TYPE.LEGISLATION_SOURCE,
  },
  legalList: { type: "resource", resourceType: RESOURCE_TYPE.LEGAL_LIST },
  legalListColumn: { type: "non_resource", reason: "subresource" },
  legalListGenerationCandidate: { type: "non_resource", reason: "workflow" },
  legalListGenerationCandidateSource: {
    type: "non_resource",
    reason: "association",
  },
  legalListGenerationRun: { type: "non_resource", reason: "job" },
  legalListGenerationSource: {
    type: "non_resource",
    reason: "association",
  },
  legalListItemComment: { type: "non_resource", reason: "subresource" },
  legalListItemReview: { type: "non_resource", reason: "subresource" },
  legalListItemSource: { type: "non_resource", reason: "subresource" },
  legalListSection: { type: "non_resource", reason: "subresource" },
  matter: { type: "alias", resourceType: RESOURCE_TYPE.WORKSPACE },
  matterCounter: { type: "non_resource", reason: "projection" },
  mcpConnector: {
    type: "resource",
    resourceType: RESOURCE_TYPE.MCP_CONNECTOR,
  },
  mcpOAuthClient: { type: "non_resource", reason: "credential" },
  mcpUserConnection: { type: "non_resource", reason: "credential" },
  organization: {
    type: "resource",
    resourceType: RESOURCE_TYPE.ORGANIZATION,
  },
  organizationSettings: { type: "non_resource", reason: "singleton" },
  pendingUpload: { type: "non_resource", reason: "workflow" },
  playbook: { type: "alias", resourceType: RESOURCE_TYPE.PLAYBOOK },
  playbookDefinition: {
    type: "resource",
    resourceType: RESOURCE_TYPE.PLAYBOOK,
  },
  playbookDefinitionVersion: {
    type: "resource",
    resourceType: RESOURCE_TYPE.PLAYBOOK_VERSION,
  },
  property: { type: "resource", resourceType: RESOURCE_TYPE.PROPERTY },
  propertyDependency: { type: "non_resource", reason: "association" },
  rateEntry: { type: "resource", resourceType: RESOURCE_TYPE.RATE_ENTRY },
  rateTable: { type: "resource", resourceType: RESOURCE_TYPE.RATE_TABLE },
  savedSearch: { type: "resource", resourceType: RESOURCE_TYPE.SAVED_SEARCH },
  reportExport: {
    type: "resource",
    resourceType: RESOURCE_TYPE.REPORT_EXPORT,
  },
  schedulerJobRun: { type: "non_resource", reason: "job" },
  sharepointConnection: { type: "non_resource", reason: "credential" },
  sharepointOAuthState: { type: "non_resource", reason: "credential" },
  styleSet: { type: "resource", resourceType: RESOURCE_TYPE.STYLE_SET },
  taskAssignee: { type: "non_resource", reason: "association" },
  task: { type: "alias", resourceType: RESOURCE_TYPE.ENTITY },
  template: { type: "resource", resourceType: RESOURCE_TYPE.TEMPLATE },
  templateCategory: {
    type: "resource",
    resourceType: RESOURCE_TYPE.TEMPLATE_CATEGORY,
  },
  templateClause: { type: "non_resource", reason: "association" },
  templateRecipe: { type: "non_resource", reason: "subresource" },
  templateFill: { type: "non_resource", reason: "workflow" },
  templatePersistenceRequest: { type: "non_resource", reason: "workflow" },
  templateVersion: {
    type: "resource",
    resourceType: RESOURCE_TYPE.TEMPLATE_VERSION,
  },
  timeEntry: { type: "resource", resourceType: RESOURCE_TYPE.TIME_ENTRY },
  user: { type: "resource", resourceType: RESOURCE_TYPE.USER },
  userFile: { type: "resource", resourceType: RESOURCE_TYPE.USER_FILE },
  workspace: { type: "resource", resourceType: RESOURCE_TYPE.WORKSPACE },
  workspaceContact: { type: "non_resource", reason: "association" },
  workspaceMember: { type: "non_resource", reason: "association" },
  workspaceView: {
    type: "resource",
    resourceType: RESOURCE_TYPE.WORKSPACE_VIEW,
  },
  workspaceViewTemplate: {
    type: "resource",
    resourceType: RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE,
  },
  workObligationEvent: { type: "non_resource", reason: "event" },
  entityLink: { type: "non_resource", reason: "association" },
  folioCollabContribution: { type: "non_resource", reason: "association" },
  folioCollabPublication: { type: "non_resource", reason: "workflow" },
} as const satisfies Record<SafeIdType, IdentityDisposition>;

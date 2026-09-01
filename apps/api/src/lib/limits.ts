import {
  AGENT_SKILLS_CHAT_METADATA_MAX,
  CHAT_RICH_PART_LIMITS,
  ENTITIES_PER_WORKSPACE_MAX,
  FLOW_RUN_INPUT_ENTITIES_MAX,
  PROPERTIES_PER_WORKSPACE_MAX,
  PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX,
  VIEW_FILTERS_MAX,
  VIEW_SORTS_MAX,
  WORKSPACES_PER_ORGANIZATION_MAX,
} from "@stll/api-contract";
import { BETTER_AUTH_ORGANIZATION_OPTIONS } from "@stll/auth-model";
import {
  CHAT_CONTEXT_FILE_MAX_BYTES,
  CHAT_CONTEXT_FILE_MAX_MEGABYTES,
} from "@stll/chat-limits";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/package-limits";

/** Hoisted so `versionFieldsScanLimit` can derive from it inside the same
 *  object literal instead of restating the page size. */
const VERSIONS_PAGE_SIZE_DEFAULT = 50;

export const LIMITS = {
  legalListsPageSizeDefault: 50,
  legalListsPageSizeMax: 100,
  legalListsPerWorkspace: 200,
  legalListSectionsPerList: 200,
  legalListColumnsPerList: 100,
  legalListItemsPageSizeDefault: 100,
  legalListItemsPageSizeMax: 500,
  legalListSourcesPageSizeDefault: 50,
  legalListSourcesPageSizeMax: 200,
  legalListGenerationSourcesMax: 100,
  legalListGenerationCandidatesMax: 200,
  legalListGenerationCandidateSourcesMax: 10,
  legalListGenerationRunsPageSizeDefault: 20,
  legalListGenerationRunsPageSizeMax: 100,
  legalListActivityPageSizeDefault: 50,
  legalListActivityPageSizeMax: 200,
  workspacesCount: WORKSPACES_PER_ORGANIZATION_MAX,
  workspaceNavigationPageSizeDefault: 100,
  workspaceNavigationPageSizeMax: 1000,
  propertiesCount: PROPERTIES_PER_WORKSPACE_MAX,
  /** Sorts one view layout or one list/window request may carry. Deliberately
   *  separate from `propertiesCount`: it also sizes the entity window cursor's
   *  byte budget, which must not grow with the column cap. */
  viewSortsCount: VIEW_SORTS_MAX,
  entitiesCount: ENTITIES_PER_WORKSPACE_MAX,
  entitiesPageSizeDefault: 100,
  entitiesPageSizeMax: 500,
  entitiesWindowSizeDefault: 200,
  entitiesWindowSizeMax: 500,
  /** Top-level filters one view layout or one list/window request may carry;
   *  also the fan-out of any one condition group. Together with the condition
   *  contract's nesting depth this bounds the size of one filter tree. */
  viewFiltersCount: VIEW_FILTERS_MAX,
  /** AI-column inputs one property may depend on: the cap on a create body
   *  and on an update that grows the stored list. */
  propertyDependenciesPerProperty: PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX,
  workflowEntityBatchSize: 500,
  /** Documents one chat cross-document consistency review may send to the
   *  review model. Larger folders remain explicit in coverage as not checked. */
  folderConsistencyReviewDocumentsMax: 20,
  /** Named not-checked documents returned to the chat model. The full count
   *  remains available without allowing a large folder to flood context. */
  folderConsistencyCoverageDocumentsMax: 100,
  /** Descendant rows retained in one folder review snapshot. This mirrors the
   *  workspace's enforced entity cap; the query reads one extra sentinel. */
  folderConsistencySnapshotEntitiesMax: ENTITIES_PER_WORKSPACE_MAX,
  /** Maximum nesting the folder review snapshot follows. A deeper tree is
   *  reported as incomplete instead of turning recursion into an open bound. */
  folderConsistencyTraversalDepthMax: 32,
  /** Levels the move handler walks up an entity's parent chain to prove the
   *  target is not one of its own descendants. A chain still continuing at the
   *  cap refuses the move: a truncated walk cannot prove the absence of a
   *  cycle. */
  entityAncestorWalkDepthMax: 100,
  /** Per-replica concurrency for the legacy workflow worker. The topology
   *  expansion preserves today's budget while every tier still routes here. */
  workflowStandardWorkerConcurrency: 10,
  /** Per-replica budget for the rollout-prepared flex queue. No producer uses
   *  this queue until the separate routing PR lands. */
  workflowFlexWorkerConcurrency: 2,
  /** Per-queue cap for orphan-reconciliation live-job snapshots. Reaching the
   *  cap in either queue skips recovery rather than risking a false orphan. */
  workflowLiveJobScanLimit: 10_000,
  /** Generous cap on versions read for one entity's history panel (newest
   *  first). Versions accumulate one-per-finalize/upload/restore with no
   *  write-side cap; 1000 is far above realistic editing histories. Cursor
   *  pagination is the proper long-term fix. */
  versionsPerEntity: 1000,
  /** Page size for one entity's version-history listing (newest first).
   *  The reader loads the most recent page first and walks older pages via
   *  the `before` cursor, so a heavily-revised entity never loses access to
   *  older versions. */
  versionsPageSizeDefault: VERSIONS_PAGE_SIZE_DEFAULT,
  /** Worst-case file fields scanned for one page of an entity's version
   *  history (versionsPageSizeDefault * propertiesCount). The reader pages
   *  versions, so the scan follows the page size, not versionsPerEntity. */
  versionFieldsScanLimit:
    VERSIONS_PAGE_SIZE_DEFAULT * PROPERTIES_PER_WORKSPACE_MAX,
  calendarTasksMax: 200,
  /** Default page size for the signed-in user's assigned tasks. */
  myTasksPageSizeDefault: 50,
  /** Max page size for the signed-in user's assigned tasks. */
  myTasksPageSizeMax: 100,
  /** Max active task assignments that account deletion will reassign in one pass. */
  accountDeletionTaskAssignmentsMax: 500,
  /** Max workspace member candidates returned for account-deletion task handoff. */
  accountDeletionTaskReassignmentCandidatesMax: 2000,
  /** Max entity-link rows returned per direction for one task. */
  taskEntityLinksPerDirectionMax: 200,
  entitySummariesPageSize: 200,
  /** Max per-user limit assignments returned for one organization. */
  usageAssignmentsMax: 1000,
  viewsCount: 20,
  viewTemplatesPerUser: 50,
  /** Per-org cap on saved playbook definitions. Per-playbook size is bounded
   *  by the positions schema's maxItems (200). */
  playbookDefinitionsCount: 100,
  playbookDefinitionsPageSizeDefault: 50,
  playbookDefinitionsPageSizeMax: 100,
  /** Per-org cap on saved flow (Workflows) definitions. Per-definition size
   *  is bounded by MAX_FLOW_STEPS in flow-types.ts. */
  flowDefinitionsCount: 100,
  flowDefinitionsPageSizeDefault: 50,
  flowDefinitionsPageSizeMax: 100,
  /** Page size for a workspace's flow-run history (newest first). */
  flowRunsPageSizeDefault: 50,
  flowRunsPageSizeMax: 100,
  /** Max input documents a single flow run may be launched against. */
  flowRunInputEntitiesMax: FLOW_RUN_INPUT_ENTITIES_MAX,
  /** Inbox feed page sizes. */
  signalsPageSizeDefault: 30,
  signalsPageSizeMax: 100,
  /** Attachments per manual request. */
  signalRequestAttachmentsMax: 10,
  /** Notification bell page sizes. The first page fills the panel; older
   *  pages load on demand, so history is never drained at mount. */
  notificationsPageSizeDefault: 20,
  notificationsPageSizeMax: 50,
  /** Addresses one comment may mention. Caps both the lookup and the fan-out
   *  so a pasted address list cannot become a broadcast. */
  mentionTargetsMax: 10,
  /** Members one announcement may reach. A larger organization is refused
   *  outright rather than announced to a truncated audience. */
  announcementRecipientsMax: 5000,
  /** Per-org cap on the editable document-type taxonomy. The taxonomy is
   *  inherently bounded (a few dozen contract categories), so the list
   *  endpoint returns a plain ordered array rather than a paginated page. */
  documentTypesCount: 100,
  /** Per-org cap on stored templates, enforced on create. */
  templatesCount: 50,
  templatesPageSizeDefault: 50,
  templatesPageSizeMax: 100,
  styleSetsCount: 100,
  styleSetsPageSizeDefault: 50,
  styleSetsPageSizeMax: 100,
  clauseCategoriesCount: 100,
  templateCategoriesCount: 100,
  templateRecipesCount: 100,
  templateRecipeFieldsMax: 50,
  /** Longest `pattern` a template manifest may carry for one field or field
   *  part. The manifest rides inside an uploaded DOCX, so the pattern is
   *  compiled and matched in-process at fill time; a longer one is skipped
   *  rather than compiled. */
  templateFieldPatternMaxLength: 200,
  /** Longest submitted value a manifest `pattern` is matched against. A longer
   *  value is rejected as a field error instead of being matched. */
  templateFieldPatternValueMaxLength: 1000,
  clausesPerOrganization: 500,
  clausesPageSizeDefault: 50,
  clausesPageSizeMax: 200,
  shortcutsPerUser: 100,
  agentSkillsPerUser: 100,
  agentSkillsPageSizeDefault: 100,
  agentSkillsPageSizeMax: 250,
  templatePacksPageSizeDefault: 50,
  templatePacksPageSizeMax: 100,
  /** Templates one install request may copy from a pack. */
  templatePackInstallTemplatesMax: 50,
  /** Flat skill catalogue injected into the chat system prompt: team skills
   *  (org-wide) plus the caller's private skills. Kept >=
   *  agentSkillsTeamPerOrganization + agentSkillsPerUser so the catalogue never
   *  truncates and silently hides a skill from the model. */
  agentSkillsChatMetadataMax: AGENT_SKILLS_CHAT_METADATA_MAX,
  /** Per-org cap on team-scoped skills, enforced on create/install. With
   *  agentSkillsPerUser it keeps team (org-wide) + the caller's private skills
   *  within agentSkillsChatMetadataMax (100 + 100 <= 200). Mirrors
   *  mcpCustomConnectorsPerOrgMax kept under its read cap. */
  agentSkillsTeamPerOrganization: 100,
  agentSkillDescriptionMaxChars: SKILL_PACKAGE_LIMITS.descriptionMaxChars,
  agentSkillCompatibilityMaxChars: SKILL_PACKAGE_LIMITS.compatibilityMaxChars,
  agentSkillLicenseMaxChars: SKILL_PACKAGE_LIMITS.licenseMaxChars,
  agentSkillMetadataEntriesMax: SKILL_PACKAGE_LIMITS.metadataEntriesMax,
  agentSkillMetadataKeyMaxChars: SKILL_PACKAGE_LIMITS.metadataKeyMaxChars,
  agentSkillMetadataValueMaxChars: SKILL_PACKAGE_LIMITS.metadataValueMaxChars,
  agentSkillVersionMaxChars: SKILL_PACKAGE_LIMITS.versionMaxChars,
  agentSkillBodyMaxChars: SKILL_PACKAGE_LIMITS.bodyMaxChars,
  agentSkillArchiveFilesMax: SKILL_PACKAGE_LIMITS.archiveFilesMax,
  agentSkillArchiveUncompressedMaxBytes:
    SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes,
  agentSkillGithubDirectoriesMax: SKILL_PACKAGE_LIMITS.githubDirectoriesMax,
  agentSkillResourcesPerSkill: SKILL_PACKAGE_LIMITS.resourcesPerSkillMax,
  agentSkillResourceMaxChars: SKILL_PACKAGE_LIMITS.resourceMaxChars,
  /** Prose a proposal author writes to explain the change. */
  agentSkillProposalSummaryMaxChars: 2000,
  /** Quoted source a comment anchors to, kept so the comment can be
   *  re-anchored once the text moves on. */
  agentSkillCommentAnchorTextMaxChars: 2000,
  agentSkillCommentBodyMaxChars: 5000,
  /** Comments returned for one skill, oldest first. */
  agentSkillCommentsPageSizeMax: 500,
  /** Revisions and proposals returned for one skill, newest first. */
  agentSkillRevisionsPageSizeMax: 100,
  agentSkillProposalsPageSizeMax: 100,
  mcpGatewayConnectorsMax: 20,
  /** Max connector rows returned by the connector catalogue listing
   *  (`GET /mcp/connectors` and the custom-MCP slice of `/catalogue`). */
  mcpConnectorsPageSizeMax: 100,
  /** Max custom MCP connectors an org can create. Kept well below
   *  `mcpConnectorsPageSizeMax` so the catalogue listing (curated + this org's
   *  custom connectors) never silently truncates a connector out of the
   *  management UI. */
  mcpCustomConnectorsPerOrgMax: 50,
  /** Max per-user MCP connection rows returned by the connections listing. */
  mcpConnectionsPageSizeMax: 100,
  /** Max OAuth consent rows ("connected apps") returned by the user's
   *  connections-settings listing. Naturally bounded per user (one row per
   *  authorized client), but still capped defensively. */
  oauthConnectionsPageSizeMax: 100,
  /** Default/max page sizes for the MCP `list_matters`-style list tools. */
  mcpListPageSizeDefault: 25,
  mcpListPageSizeMax: 100,
  /** Default/max page sizes for the MCP search tools. */
  mcpSearchPageSizeDefault: 10,
  mcpSearchPageSizeMax: 20,
  /** Default page size for the OpenAI-compatible MCP search tool. */
  mcpCompatSearchPageSizeDefault: 8,
  mcpGatewaySkillsMax: 100,
  mcpGatewayToolsPerConnectorMax: 100,
  mcpGatewayToolNameMaxChars: 128,
  mcpGatewayToolDescriptionMaxChars: 2000,
  mcpGatewayToolSchemaMaxChars: 20_000,
  mcpGatewayRateLimitWindowMs: 60_000,
  mcpGatewayRateLimitMax: 60,
  clauseVariantsPerClause: 10,
  clauseVersionsPerClause: 50,
  templateClausesPerTemplate: 50,
  templateVersionsPerTemplate: 50,
  /** Approval-snapshot history per playbook (one row per `approve` call, never
   *  trimmed). Mirrors `templateVersionsPerTemplate`; the listing is a plain
   *  bounded array (newest first), not cursor-paginated — see
   *  `list-versions.ts`. */
  playbookDefinitionVersionsPerPlaybook: 50,
  rateTablesPerWorkspace: 50,
  rateTablesPageSizeDefault: 50,
  rateTablesPageSizeMax: 200,
  rateEntriesPerTable: 200,
  rateEntriesPageSizeDefault: 200,
  rateEntriesPageSizeMax: 500,
  timeEntriesPerWorkspace: 50_000,
  timeEntriesPageSizeDefault: 100,
  timeEntriesPageSizeMax: 200,
  expensesPerWorkspace: 10_000,
  expensesPageSizeDefault: 100,
  expensesPageSizeMax: 200,
  billingCodesPerWorkspace: 500,
  billingCodesPageSizeDefault: 500,
  billingCodesPageSizeMax: 1000,
  overviewRecentEntities: 10,
  /** Initial number of mixed chat/entity rows shown beneath one matter in
   *  persistent sidebar chrome. Additional rows are cursor-paginated. */
  workspaceActivityPageSizeDefault: 3,
  workspaceActivityPageSizeMax: 10,
  activeTimersPerUser: 1,
  timeEntryMaxAgeDays: 90,
  billingIncrementMinutes: 6,
  invoicesPerWorkspace: 10_000,
  invoicesPageSizeDefault: 50,
  invoicesPageSizeMax: 100,
  exportRowLimit: 10_000,
  exportPdfRowLimit: 5000,
  /** Hard cap on rows (contracts) a single view-to-report export may span.
   *  A DD report drafts per-contract AI narrative, so the row count bounds
   *  the metered model calls; exceeding it at enqueue/build time is a typed
   *  error rather than a truncated report. */
  reportExportMaxRows: 500,
  /** Default and maximum receipt-history page sizes. History remains bounded
   *  even for matters with years of report exports. */
  reportExportsPageSizeDefault: 20,
  reportExportsPageSizeMax: 100,
  auditLogPageSizeDefault: 50,
  auditLogPageSizeMax: 200,
  matterActivityPageSizeDefault: 15,
  matterActivityPageSizeMax: 50,
  matterActivityActorPageSizeDefault: 50,
  matterActivityActorPageSizeMax: 100,
  /** Page sizes for the operator recent-registrations listing. */
  operatorRegistrationsPageSizeDefault: 50,
  operatorRegistrationsPageSizeMax: 200,
  contactsCount: 10_000,
  contactsPageSizeDefault: 50,
  contactsPageSizeMax: 100,
  /** Max rows in one reviewed contact import batch (mirrors
   *  clauseImportBatchLimit's role for clause JSON import). */
  contactsImportRowsMax: 500,
  /** Max characters in one imported contact's notes cell. */
  contactsImportNotesMaxChars: 50_000,
  contactRelationshipsCount: 50,
  workspaceContactsCount: 100,
  /** Better Auth organization member cap and full-org read bound. */
  organizationMembersCount: BETTER_AUTH_ORGANIZATION_OPTIONS.membershipLimit,
  workspaceMembersCount: 500,
  /** Max governed obligations synchronously unassigned during member removal. */
  workspaceMemberRemovalWorkObligationsMax: 500,
  practiceJurisdictionsPerOrganization: 12,
  entityNameMaxLength: 255,
  workspaceContributors: 5,
  searchQueryMaxLength: 500,
  searchPageSizeDefault: 20,
  searchPageSizeMax: 100,
  /** Maximum visible text returned by any global-search preview response. */
  searchPreviewResponseCharacterLimit: 16_000,
  /** Messages surrounding the best match in a global-search chat preview. */
  searchChatPreviewMessageLimit: 6,
  savedSearchesPerUser: 100,
  savedSearchesPageSizeDefault: 50,
  savedSearchesPageSizeMax: 100,
  /** Cap on the rolled-up message text indexed per chat thread for
   *  global search. Bounds the stored tsv so a long conversation
   *  cannot blow up the index; the headline only reads the first
   *  2000 chars anyway. */
  chatSearchTextMaxLength: 50_000,
  /** Cap on searchable text indexed for one chat message. */
  chatMessageSearchTextMaxLength: 8000,
  /** Default result count for the internal chat-history search tool. */
  chatHistorySearchPageSizeDefault: 6,
  /** Max result count for the internal chat-history search tool. */
  chatHistorySearchPageSizeMax: 10,
  /** Max messages returned before or after a history expansion target. */
  chatHistoryExpansionSideMax: 5,
  extractedContentMaxChars: 500_000,
  /** Leading characters of a document handed to `ts_headline` for a result
   *  snippet. Every search branch bounds its document the same way: the cost
   *  of the highlight scales with the text passed in, and a full decision
   *  fulltext is orders of magnitude larger than the snippet it yields. */
  searchHeadlineDocumentMaxChars: 2000,
  /** Maximum encrypted OCR page-geometry payload before AES-GCM overhead. */
  documentOcrPayloadMaxBytes: 16 * 1024 * 1024,
  /** Maximum source PDF the local OCR provider will read and render. */
  documentOcrSourceMaxBytes: 200 * 1024 * 1024,
  /** Cursor page size for document- and matter-deletion OCR derivative
   *  cleanup. Also caps the storage keys recorded per cleanup request. */
  ocrDerivativeCleanupBatchSize: 1000,
  /** Cleanup-request pages one organization deletion may record. Each page
   *  holds up to `ocrDerivativeCleanupBatchSize` storage keys, so this bounds
   *  the enumeration that runs inside the transaction removing the
   *  organization. Reaching it rejects the deletion rather than dropping the
   *  remainder: an unrecorded page is an object nothing can name again. */
  organizationStorageTeardownPagesMax: 1000,
  /** Source pixels (width × height) the thumbnail pipeline will decode. The
   *  encoded file size does not bound the work: a small file can declare a
   *  surface of any size, so the budget is checked against the header
   *  dimensions before the surface is allocated. */
  imageDerivativeSourcePixelsMax: 40_000_000,
  /** Wall-clock ceiling for one thumbnail plus blur placeholder. */
  imageDerivativeTimeoutMs: 30_000,
  /** Hard timeout for adding a searchable text layer to one PDF. */
  ocrPdfGenerationTimeoutMs: 2 * 60_000,
  /** Hard timeout (ms) for the sandboxed extraction subprocess. */
  extractionTimeoutMs: 30_000,
  /** Hard timeout for durable background document extraction. */
  documentProcessingExtractionTimeoutMs: 2 * 60_000,
  /** Wall-clock ceiling for one document-processing object-storage read. */
  documentProcessingObjectReadTimeoutMs: 30_000,
  /** Wall-clock ceiling (ms) for the live DOCX-to-Markdown read path in
   *  `read_content_across_matters`: the S3 file fetch plus the in-process
   *  folio conversion of a single document. Mirrors `extractionTimeoutMs`'s
   *  budget for the same class of work (one document-sized file). */
  docxMarkdownConversionTimeoutMs: 30_000,
  /** Wall-clock ceiling for writing one generated chat export to object storage. */
  chatExportObjectIoTimeoutMs: 30_000,
  clauseExportLimit: 500,
  clauseImportBatchLimit: 200,
  templateFillsRetentionDays: 365,
  caseLawMatterLinksPerWorkspace: 1000,
  /** Research tables one member may own; a bound, not a plan limit. */
  caseLawResearchTablesPerUser: 200,
  caseLawResearchTablesPageSizeDefault: 50,
  caseLawResearchTablesPageSizeMax: 100,
  /** Pinned plus excluded decisions per research table. */
  caseLawResearchTableDecisionsMax: 500,
  /** Question columns per research table. */
  caseLawResearchColumnsPerTable: 20,
  /** Decisions one run request may queue; the client batches beyond it. */
  caseLawResearchRunDecisionsMax: 100,
  /** Decisions answered concurrently inside one run. */
  caseLawResearchRunConcurrency: 3,
  /** Decisions one answers lookup may name; the client asks for what it shows. */
  caseLawResearchAnswersLookupDecisionsMax: 500,
  /** A pending cell older than this is a run that died and may be re-queued. */
  caseLawResearchPendingStaleMs: 10 * 60 * 1000,
  /** Decision text sent whole to the model; longer texts are retrieved by passage. */
  caseLawResearchAnswerTextBudgetChars: 60_000,
  /** Passages retrieved for one over-budget decision, and the cap on each. */
  caseLawResearchAnswerPassagesMax: 12,
  caseLawResearchAnswerPassageChars: 1500,
  /** Rationale kept beside an answer. */
  caseLawResearchAnswerRationaleChars: 600,
  caseLawDecisionCitationPageSize: 50,
  caseLawAnnotationsPageSizeDefault: 100,
  caseLawAnnotationsPageSizeMax: 100,
  caseLawSearchPageSizeDefault: 20,
  caseLawSearchPageSizeMax: 100,
  /** Max language variants for one decision's languageGroupKey. Bounds the
   *  alternate-language reads (decision detail + sitemap hreflang) so a
   *  malformed/over-merged group key cannot load an unbounded set. */
  caseLawLanguageAlternatesPerGroupMax: 30,
  /** Max URL entries in one sitemap file by protocol. */
  caseLawSitemapUrlLimit: 50_000,
  /** Conservative per-shard case-law sitemap cap; leaves room for hreflang alternates under the XML byte limit. */
  caseLawSitemapShardUrlLimit: 5000,
  /** Max child sitemap entries in one sitemap index by protocol. */
  caseLawSitemapIndexEntryLimit: 50_000,
  caseLawFacetLimit: 20,
  /** One-row budget for the headnote a list row shows under the case number. */
  caseLawHeadnoteMaxChars: 240,
  /** Courts on the browse page's "newest decisions" shelf, by corpus size. */
  caseLawLatestCourts: 4,
  caseLawLatestPerCourt: 5,
  legislationListPageSizeDefault: 20,
  legislationListPageSizeMax: 100,
  /** Consolidated versions of one work returned per page. */
  legislationVersionsPageSizeDefault: 50,
  legislationVersionsPageSizeMax: 200,
  /**
   * Versions inspected per page of one provision's history. Each one costs a
   * document-AST read, so the page stays far below the version page size.
   */
  legislationProvisionHistoryPageSizeDefault: 5,
  legislationProvisionHistoryPageSizeMax: 20,
  caseLawPolarityRulesPerLanguage: 500,
  // corpus index two-stage search: lexical candidates fetched per index window
  // before the citation-authority rerank.
  corpusIndexSearchCandidateLimit: 300,
  // Max corpus-index lexical candidates scanned across windows for one
  // cursor request.
  corpusIndexSearchScanLimit: 10_000,
  // Decisions pushed to corpus index per indexer batch.
  corpusIndexBatchSize: 50,
  /** Max UTF-8 bytes in one corpus-index NDJSON ingest request. A batch is
   *  sized in rows, but a passage-granular family turns one row into as many
   *  documents as it has passages, so the serialized body is not bounded by
   *  the row count; this bounds the string held in memory and sent as one
   *  request. Split only at row boundaries, so one very long document can
   *  exceed it (see splitIngestRequests). */
  corpusIndexIngestMaxBytes: 8 * 1024 * 1024,
  /** Wall-clock ceiling (ms) for a single corpus object read/write/delete.
   *  Corpus payloads are individual court decisions or statute texts (a few
   *  MB at most), so an operation that outlives this is a stalled socket, not
   *  a slow-but-live transfer. Bounds every corpus S3 call so a wedged
   *  transfer can never freeze a daemon loop. */
  corpusObjectIoTimeoutMs: 60_000,
  /** Max decompressed bytes for one corpus object. Real payloads are a few
   *  MB; anything past this ceiling is a corrupt or hostile object, and
   *  rejecting it here keeps a giant string away from JSON.parse and the
   *  chunker, whose cost scales with input size on the daemon's thread. */
  corpusPayloadMaxDecompressedBytes: 128 * 1024 * 1024,
  infoSoudEventsMax: 200,
  infoSoudHearingsMax: 50,
  infoSoudRelatedCasesMax: 50,
  infoSoudAgendaImportItemsMax: 1000,
  infoSoudTrackedCasesSyncBatch: 50,
  /** Obligations the work-attention scout reads per tick. The sweep is a
   *  keyset cycle over open governed work, so the page size bounds one tick's
   *  cost rather than the corpus it eventually covers. */
  workAttentionObligationsPage: 500,
  agendaAttendeesMax: 500,
  /** Max chat context file attachment size per file. */
  chatContextFileMaxChars: 16_000,
  /** Max total chars across all text attachments per message. */
  chatContextTextMaxChars: 32_000,
  /** Max number of file attachments per chat message. */
  chatContextFilesPerMessage: 5,
  /** Max encoded inline audio/video payload stored in one chat part. Large
   * generated media should use a URL instead of inflating every history read. */
  chatRichMediaInlineMaxChars: CHAT_RICH_PART_LIMITS.inlineMediaMaxChars,
  chatRichMediaMimeTypeMaxChars: CHAT_RICH_PART_LIMITS.mediaMimeTypeMaxChars,
  chatRichMediaUrlMaxChars: CHAT_RICH_PART_LIMITS.mediaUrlMaxChars,
  chatRichPartIdentifierMaxChars: CHAT_RICH_PART_LIMITS.identifierMaxChars,
  /** Max number of rich presentation parts stored in one message. */
  chatRichPartsPerMessageMax: 16,
  /** Max serialized UTF-8 bytes across rich presentation parts in one
   * message. Keeps one generated media payload valid while bounding JSONB
   * row size and repeated history transfer cost. */
  chatRichPartsTotalMaxBytes: 5 * 1024 * 1024,
  /** Max text or base64 payload stored for one sandboxed MCP App resource. */
  chatUiResourceContentMaxChars:
    CHAT_RICH_PART_LIMITS.uiResourceContentMaxChars,
  /** Max length of the routing URI on one persisted MCP App resource. */
  chatUiResourceUriMaxChars: CHAT_RICH_PART_LIMITS.uiResourceUriMaxChars,
  /** Default page size for the user's chat thread history. */
  chatThreadListPageSizeDefault: 50,
  /** Max page size for the user's chat thread history. */
  chatThreadListPageSizeMax: 100,
  /** Default page size for one chat thread's message history. The reader
   *  loads the most recent page first and fetches older pages on demand
   *  as the user scrolls up, so a long conversation never loads in full. */
  chatMessagesPageSizeDefault: 50,
  /** Max page size for one chat thread's message history. */
  chatMessagesPageSizeMax: 100,
  /** Hard cap on the per-send message window loaded for a chat turn. Threads
   *  that never form a compaction checkpoint (e.g. anonymized threads) rely on
   *  this so a send cannot load an unbounded history; sized well above the
   *  compaction trigger so a checkpointed thread's window is unaffected. */
  chatSendHistoryWindowMax: 500,
  /** Max DOCX size for stamp injection (bytes). */
  docxStampMaxBytes: 50 * 1024 * 1024,
  /** Max org-wide custom blacklist terms for anonymization. */
  anonymizationBlacklistEntriesPerOrganization: 1000,
  /** Max workspace-scoped custom blacklist terms for anonymization. */
  anonymizationBlacklistEntriesPerWorkspace: 1000,
  /** Max variants per org-wide custom blacklist term. */
  anonymizationBlacklistVariantsPerEntry: 20,
  /** Max workspace-scoped anonymization allowlist (never-mask) entries. */
  anonymizationAllowlistEntriesPerWorkspace: 1000,
  /** Recent sessions scanned to detect a new-device/new-IP login. */
  newDeviceLoginSessionScanLimit: 10,
} as const;

/**
 * File upload size limits.
 * Values use Elysia's human-readable format (e.g. "50m" = 50 MB).
 */
export const FILE_SIZE_LIMITS = {
  /** General document uploads (entities, templates). */
  document: "50m",
  /** Structured data imports (clause JSON). */
  dataImport: "10m",
  /** Agent skill packs (`SKILL.md` or a ZIP folder). */
  skillPack: "2m",
  /** Chat context file attachments. */
  chatContextFile: `${CHAT_CONTEXT_FILE_MAX_MEGABYTES}m`,
} as const;

/**
 * File upload size limits in bytes for code paths that need to
 * validate before a framework-level t.File() parser runs.
 */
export const FILE_SIZE_LIMIT_BYTES = {
  /** General document uploads (entities, templates). */
  document: 50 * 1024 * 1024,
  /** Agent skill packs (`SKILL.md` or a ZIP folder). */
  skillPack: 2 * 1024 * 1024,
  /** Chat context file attachments. */
  chatContextFile: CHAT_CONTEXT_FILE_MAX_BYTES,
} as const;

/**
 * Rate limits for auth endpoints (better-auth built-in limiter).
 * Window is in seconds, max is the request ceiling per window.
 */
export const AUTH_RATE_LIMITS = {
  global: { window: 60, max: 100 },
  signIn: { window: 60, max: 5 },
  signUp: { window: 60, max: 3 },
  sendOtp: { window: 60, max: 5 },
  verifyOtp: { window: 60, max: 5 },
  forgetPassword: { window: 60, max: 3 },
  resetPassword: { window: 60, max: 5 },
} as const;

/**
 * Longer-lived limits for new-account OTP requests. Rate-limited requests are
 * acknowledged without sending an OTP, keeping account state out of the HTTP
 * response while preserving existing users' login capacity.
 */
export const NEW_ACCOUNT_OTP_RATE_LIMITS = {
  email: { duration: 60 * 60 * 1000, max: 3 },
  ip: { duration: 3 * 60 * 60 * 1000, max: 25 },
} as const;

/**
 * Fixed production response delay for sign-in email-OTP requests. Delivery and
 * suppression continue independently so provider latency cannot reveal account
 * state through the HTTP response.
 */
export const EMAIL_OTP_MIN_RESPONSE_DURATION_MS = 1000;

/**
 * Rate limits for API endpoints.
 * Duration is in milliseconds, max is the request ceiling
 * per duration window.
 */
export const API_RATE_LIMITS = {
  /** REST API: 1000 req/min per IP. Covers normal navigation
   *  (5-10 requests per page load × frequent workspace switching). */
  api: { duration: 60_000, max: 1000 },
  /** Skill URL discovery/import: 10 req/min per IP. Each request performs
   *  bounded outbound source fetches, so this separate cap prevents the
   *  general API budget from amplifying third-party traffic. */
  skillSource: { duration: 60_000, max: 10 },
  /** File uploads: 500 req/min (separate budget). */
  upload: { duration: 60_000, max: 500 },
  /** Folio collaborative-edit token endpoints: 30 req/min per IP.
   *  Each authorize/refresh/snapshot call runs a multi-table join
   *  against unauthenticated input, so the budget is intentionally
   *  much tighter than the general API. */
  folioCollab: { duration: 60_000, max: 30 },
  /** Agent-auth registration + claim-grant poll endpoints: 60 req/min
   *  per IP. These are unauthenticated and pollable (RFC 8628 device
   *  flow), so they get a dedicated, tight budget separate from the
   *  general API. The poll interval is enforced server-side per
   *  registration; this IP cap bounds an attacker registering or
   *  polling in bulk. */
  agentAuth: { duration: 60_000, max: 60 },
  /** Document translation: 30 req/min per IP. Each call ships a
   *  full document to the external translation provider and
   *  consumes the org's paid character quota, so this stays well
   *  below the upload budget. */
  translate: { duration: 60_000, max: 30 },
  /** Hosted usage webhook ingest: 300 req/min per IP. Each request
   *  triggers HMAC verification over up to ~64 KB and a database
   *  transaction; the cap protects the route from an
   *  unauthenticated attacker driving CPU/DB cost. Legitimate
   *  provider traffic peaks well below 5 req/sec for any single
   *  source IP, so this is loose enough for production while
   *  still bounding the worst case. */
  hostedUsageWebhook: { duration: 60_000, max: 300 },
  /** Delete account OTP email request limit: 5 requests per minute. */
  deleteAccountOtp: { duration: 60_000, max: 5 },
  /** Two-factor management (enable/disable/get-totp-uri/regenerate-backup-codes)
   *  confirmation OTP email request limit: 5 requests per minute. */
  twoFactorManageOtp: { duration: 60_000, max: 5 },
} as const;

/* eslint-disable oxc/no-barrel-file -- Keep the existing "@/api/db/schema" public import path while table definitions live in domain modules. */
export * from "./schema/contacts";
export * from "./schema/properties";
export * from "./schema/entities";
export * from "./schema/templates";
export * from "./schema/billing";
export * from "./schema/workspace-admin";
export * from "./schema/clauses";
export * from "./schema/corpus-index-jobs";
export * from "./schema/case-law";
export * from "./schema/legislation";
export * from "./schema/corpus-index-generations";
export * from "./schema/corpus-index-projections";
export * from "./schema/lists";
export * from "./schema/chat";
export * from "./schema/docx-suggestions";
export * from "./schema/extraction-runs";
export * from "./schema/document-processing";
export * from "./schema/bilingual";
export * from "./schema/document-translations";
export * from "./schema/document-reviews";
export * from "./schema/office-evidence";
export * from "./schema/flows";
export * from "./schema/mcp";
export * from "./schema/sharepoint";
export * from "./schema/files-views";
export * from "./schema/reports";
export * from "./schema/skills";
export * from "./schema/style-sets";
export * from "./schema/saved-searches";
export * from "./schema/usage";
export * from "./schema/workflow";
export * from "./schema/signals";
export * from "./schema/notifications";
export * from "./schema/relations";
export {
  ACCOUNT_DELETION_REQUEST_STATUSES,
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES,
  ENTITY_DELETION_CLEANUP_STATUSES,
  BILLING_STATUS,
  CHAT_COMPACTION_MEMORY_ELIGIBILITIES,
  CHAT_COMPACTION_MEMORY_ELIGIBILITY,
  CHAT_COMPACTION_MEMORY_EXTRACTABLE,
  CHAT_TITLE_SOURCE,
  CHAT_TITLE_SOURCES,
  ENTITY_KINDS,
  LIST_ITEM_TYPES,
  EXPENSE_CATEGORIES,
  PROPERTY_ROLES,
  PROPERTY_STATUSES,
  SEARCH_PROJECTION_KINDS,
  TASK_ASSIGNEE_ROLES,
  TIME_ENTRY_SOURCE,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
} from "./schema/common";
export type {
  AccountDeletionRequestStatus,
  AccountDeletionStorageCleanup,
  DestructiveEffectChunkStatus,
  AgendaAttendee,
  AgendaAvailability,
  AgendaExternalData,
  AgendaItemKind,
  AgendaItemSource,
  AgendaParticipant,
  AgendaRecurrence,
  AgendaSensitivity,
  AnyPgColumn,
  BankAccount,
  BillingAddress,
  BoundingBoxes,
  CellMetadata,
  ChatCompactionMemoryEligibility,
  ChatCompactionSummary,
  ChatMessageRole,
  ChatTitleSource,
  ClauseBody,
  ClauseMetadata,
  ConditionNode,
  ContactAddress,
  ContactEmail,
  ContactPersistedMetadata,
  ContactPhone,
  CorpusSourceDescriptor,
  CentsAmount,
  DecisionSection,
  DocxFolioJustificationBlock,
  DocumentAst,
  EmptyAst,
  EntityKind,
  EntityDeletionCleanupStatus,
  ExpenseCategory,
  FieldContent,
  JustificationBlock,
  JustificationContent,
  LinkMetadata,
  ListItemType,
  PdfBatesJustificationBlock,
  PersistedChatMessageContent,
  PersistedDecisionAnalysis,
  PlaybookDefinitionStatus,
  PlaybookPositions,
  PlaybookScope,
  PracticeJurisdiction,
  PropertyContent,
  PropertyRole,
  PropertyStatus,
  PropertyTool,
  SafeId,
  SafeIdType,
  SchedulerDailySchedule,
  SchedulerIntervalSchedule,
  SchedulerPayload,
  SchedulerSchedule,
  SearchProjectionKind,
  TemplateManifest,
  TemplateRecipeDefinition,
  TimeEntrySource,
  TimeEntryStatus,
  VerdictMatchedRef,
  VerdictRationaleJustificationBlock,
  ViewLayout,
  ViewTemplateProperty,
} from "./schema/common";

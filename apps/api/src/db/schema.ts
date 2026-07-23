/* eslint-disable oxc/no-barrel-file -- Keep the existing "@/api/db/schema" public import path while table definitions live in domain modules. */
export * from "./schema/contacts";
export * from "./schema/properties";
export * from "./schema/entities";
export * from "./schema/templates";
export * from "./schema/billing";
export * from "./schema/workspace-admin";
export * from "./schema/clauses";
export * from "./schema/case-law";
export * from "./schema/legislation";
export * from "./schema/chat";
export * from "./schema/docx-suggestions";
export * from "./schema/extraction-runs";
export * from "./schema/flows";
export * from "./schema/mcp";
export * from "./schema/files-views";
export * from "./schema/reports";
export * from "./schema/skills";
export * from "./schema/style-sets";
export * from "./schema/usage";
export * from "./schema/relations";
export {
  ACCOUNT_DELETION_REQUEST_STATUSES,
  BILLING_STATUS,
  CHAT_TITLE_SOURCE,
  CHAT_TITLE_SOURCES,
  ENTITY_KINDS,
  EXPENSE_CATEGORIES,
  PROPERTY_ROLES,
  PROPERTY_STATUSES,
  TASK_ASSIGNEE_ROLES,
  TIME_ENTRY_SOURCE,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
} from "./schema/common";
export type {
  AccountDeletionRequestStatus,
  AccountDeletionStorageCleanup,
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
  ExpenseCategory,
  FieldContent,
  JustificationBlock,
  JustificationContent,
  LinkMetadata,
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
  TemplateManifest,
  TemplateRecipeDefinition,
  TimeEntrySource,
  TimeEntryStatus,
  VerdictMatchedRef,
  VerdictRationaleJustificationBlock,
  ViewLayout,
  ViewTemplateProperty,
} from "./schema/common";

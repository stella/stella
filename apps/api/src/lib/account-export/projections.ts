import type {
  agentSkillResources,
  agentSkillRevisions,
  agentSkills,
  aiMemories,
  billingDraftUserSettings,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  legalReaderAnnotations,
  legalReaderAnswerMessages,
  legalReaderAnswers,
  savedSearches,
  savedTimeNarratives,
  searchHistoryEntries,
  templateLookupFormatUserDefaults,
  userFiles,
  userProfessionalUseAcceptances,
  workspaceViewTemplates,
} from "@/api/db/schema";
import type { ExportedAccountTableName } from "@/api/lib/account-export/registry";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  listAccountMembershipPage,
  readAccountProfileForExport,
} from "@/api/lib/db/account-row";
import type { readOwnFeedbackReportPage } from "@/api/lib/db/feedback-report-store";

type PageItem<Read extends (...args: never[]) => Promise<unknown[]>> = Awaited<
  ReturnType<Read>
>[number];

/** What each exported table's page owner hands to its projection. */
type AccountExportProjectionSignatures = {
  user: (
    row: NonNullable<Awaited<ReturnType<typeof readAccountProfileForExport>>>,
  ) => unknown;
  member: (row: PageItem<typeof listAccountMembershipPage>) => unknown;
  user_professional_use_acceptances: (
    row: typeof userProfessionalUseAcceptances.$inferSelect,
  ) => unknown;
  feedback_reports: (
    row: PageItem<typeof readOwnFeedbackReportPage>,
  ) => unknown;
  chat_threads: (row: typeof chatThreads.$inferSelect) => unknown;
  chat_messages: (row: typeof chatMessages.$inferSelect) => unknown;
  chat_message_revisions: (
    row: typeof chatMessageRevisions.$inferSelect,
    role: (typeof chatMessages.$inferSelect)["role"],
  ) => unknown;
  ai_memories: (row: typeof aiMemories.$inferSelect) => unknown;
  agent_skills: (
    row: typeof agentSkills.$inferSelect,
    resources: (typeof agentSkillResources.$inferSelect)[],
  ) => unknown;
  agent_skill_revisions: (
    row: typeof agentSkillRevisions.$inferSelect,
  ) => unknown;
  saved_searches: (row: typeof savedSearches.$inferSelect) => unknown;
  search_history_entries: (
    organizationId: SafeId<"organization">,
    row: typeof searchHistoryEntries.$inferSelect,
  ) => Promise<unknown>;
  legal_reader_annotations: (
    row: typeof legalReaderAnnotations.$inferSelect,
  ) => unknown;
  legal_reader_answers: (
    row: typeof legalReaderAnswers.$inferSelect,
    messages: (typeof legalReaderAnswerMessages.$inferSelect)[],
  ) => unknown;
  saved_time_narratives: (
    row: typeof savedTimeNarratives.$inferSelect,
  ) => unknown;
  billing_draft_user_settings: (
    row: typeof billingDraftUserSettings.$inferSelect,
  ) => unknown;
  template_lookup_format_user_defaults: (
    row: typeof templateLookupFormatUserDefaults.$inferSelect,
  ) => unknown;
  workspace_view_templates: (
    row: typeof workspaceViewTemplates.$inferSelect,
  ) => unknown;
  // The archive path is derived from the persisted id, never a filename.
  user_files: (row: typeof userFiles.$inferSelect) => { archivePath: string };
};

/**
 * One owning projection per exported table. Projections stay in the domain
 * that serves the same rows over the API, so the composition root binds them
 * (apps/api/src/account-export-projections.ts) instead of this library
 * importing handler slices.
 */
export type AccountExportProjections = {
  readonly [
    Table in ExportedAccountTableName
  ]: AccountExportProjectionSignatures[Table];
};

type UnsignedExportedTable = Exclude<
  ExportedAccountTableName,
  keyof AccountExportProjectionSignatures
>;
type SignatureWithoutExportedTable = Exclude<
  keyof AccountExportProjectionSignatures,
  ExportedAccountTableName
>;
true satisfies UnsignedExportedTable extends never ? true : never;
true satisfies SignatureWithoutExportedTable extends never ? true : never;

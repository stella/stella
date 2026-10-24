import {
  toPersonalChatMessageResponse,
  toPersonalChatMessageRevisionResponse,
  toPersonalChatThreadResponse,
} from "@/api/handlers/chat/personal-data-response";
import { toBillingDraftSettingsAccountExport } from "@/api/handlers/desktop-time-entries/billing-draft-settings-export";
import { projectPrivateAnnotationForAccountExport } from "@/api/handlers/legal-reader/annotations/personal-data-response";
import { projectPrivateReaderAnswerForAccountExport } from "@/api/handlers/legal-reader/answers/personal-data-response";
import { toMemoryResponse } from "@/api/handlers/memories/response";
import { toSavedSearchResponse } from "@/api/handlers/saved-searches/response";
import { toSavedTimeNarrativeItem } from "@/api/handlers/saved-time-narratives/schema";
import { toSearchHistoryEntryResponse } from "@/api/handlers/search-history/entries";
import {
  toAgentSkillResponse,
  toAgentSkillRevisionResponse,
} from "@/api/handlers/skills/response";
import { toUserDefaultAccountExport } from "@/api/handlers/templates/lookup-formats/projection";
import { toPersonalUserFileResponse } from "@/api/handlers/user-files/personal-data-response";
import { toPersonalViewTemplateResponse } from "@/api/handlers/view-templates/personal-data-response";
import type { AccountExportProjections } from "@/api/lib/account-export/projections";
import {
  projectAccountMembership,
  projectAccountProfile,
} from "@/api/lib/db/account-profile-projection";
import { projectFeedbackReportForAccountExport } from "@/api/lib/db/feedback-report-projection";
import { projectProfessionalUseAcceptanceForAccountExport } from "@/api/lib/db/professional-use-projection";

/**
 * Binds each exported table to the projection its owning domain already
 * serves, so an archive row has the same shape as the API response.
 */
export const ACCOUNT_EXPORT_PROJECTIONS = {
  user: projectAccountProfile,
  member: projectAccountMembership,
  user_professional_use_acceptances:
    projectProfessionalUseAcceptanceForAccountExport,
  feedback_reports: projectFeedbackReportForAccountExport,
  legal_reader_annotations: projectPrivateAnnotationForAccountExport,
  legal_reader_answers: projectPrivateReaderAnswerForAccountExport,
  saved_time_narratives: toSavedTimeNarrativeItem,
  billing_draft_user_settings: toBillingDraftSettingsAccountExport,
  template_lookup_format_user_defaults: toUserDefaultAccountExport,
  chat_threads: toPersonalChatThreadResponse,
  chat_messages: toPersonalChatMessageResponse,
  chat_message_revisions: toPersonalChatMessageRevisionResponse,
  ai_memories: toMemoryResponse,
  agent_skills: toAgentSkillResponse,
  agent_skill_revisions: toAgentSkillRevisionResponse,
  saved_searches: toSavedSearchResponse,
  search_history_entries: toSearchHistoryEntryResponse,
  user_files: toPersonalUserFileResponse,
  workspace_view_templates: toPersonalViewTemplateResponse,
} as const satisfies AccountExportProjections;

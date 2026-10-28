import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditAction,
  type AuditResourceType,
} from "@stll/api-contract/audit-log";

import type { TranslationKey } from "@/i18n/types";

export const AUDIT_ACTION_PROJECTIONS = {
  [AUDIT_ACTION.MCP_WEB_HANDOFF_CONFIRMATION_SHOWN]:
    "settings.organization.auditLogsSentenceConfirmationShown",
  [AUDIT_ACTION.MCP_WEB_HANDOFF_ISSUED]:
    "settings.organization.auditLogsSentenceIssued",
  [AUDIT_ACTION.MCP_WEB_HANDOFF_REDEEMED]:
    "settings.organization.auditLogsSentenceRedeemed",
  [AUDIT_ACTION.MCP_WEB_HANDOFF_REFUSED]:
    "settings.organization.auditLogsSentenceRefused",
  [AUDIT_ACTION.CREATE]: "settings.organization.auditLogsSentenceCreate",
  [AUDIT_ACTION.UPDATE]: "settings.organization.auditLogsSentenceUpdate",
  [AUDIT_ACTION.DELETE]: "settings.organization.auditLogsSentenceDelete",
  [AUDIT_ACTION.DOWNLOAD]: "settings.organization.auditLogsSentenceDownload",
  [AUDIT_ACTION.EXECUTE]: "settings.organization.auditLogsSentenceExecute",
  [AUDIT_ACTION.ACCESS]: "settings.organization.auditLogsSentenceAccess",
  [AUDIT_ACTION.CANCEL]: "settings.organization.auditLogsSentenceCancel",
  [AUDIT_ACTION.REVIEW]: "settings.organization.auditLogsSentenceReview",
  [AUDIT_ACTION.SYNTHETIC_SESSION_MINTED]:
    "settings.organization.auditLogsSentenceSessionCreated",
} as const satisfies Record<AuditAction, TranslationKey>;

export const AUDIT_RESOURCE_PROJECTIONS = {
  [AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF]:
    "settings.organization.auditResourceKinds.mcp_web_handoff",
  [AUDIT_RESOURCE_TYPE.SERVICE_OAUTH_CLIENT]:
    "settings.organization.auditResourceKinds.service_oauth_client",
  [AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE]:
    "settings.organization.auditResourceKinds.legal_resolve",
  [AUDIT_RESOURCE_TYPE.AUDIT_LOG]: "consent.summaryAdminRead",
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL]:
    "settings.organization.auditResourceKinds.agent_skill",
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT]:
    "settings.organization.auditResourceKinds.agent_skill_comment",
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]:
    "settings.organization.auditResourceKinds.agent_skill_proposal",
  [AUDIT_RESOURCE_TYPE.AI_MEMORY]:
    "settings.organization.auditResourceKinds.ai_memory",
  [AUDIT_RESOURCE_TYPE.ANNOUNCEMENT]:
    "settings.organization.auditResourceKinds.announcement",
  [AUDIT_RESOURCE_TYPE.BILLING_CODE]:
    "settings.organization.auditResourceKinds.billing_code",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK]:
    "settings.organization.auditResourceKinds.case_law_matter_link",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION]:
    "settings.organization.auditResourceKinds.case_law_decision_annotation",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER]:
    "settings.organization.auditResourceKinds.case_law_reader_answer",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN]:
    "settings.organization.auditResourceKinds.case_law_research_column",
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]:
    "settings.organization.auditResourceKinds.chat_file",
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]:
    "settings.organization.auditResourceKinds.chat_message",
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]:
    "settings.organization.auditResourceKinds.chat_thread",
  [AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION]:
    "settings.organization.auditResourceKinds.chat_tool_execution",
  [AUDIT_RESOURCE_TYPE.CHAT_TOOL_GRANT]:
    "settings.organization.auditResourceKinds.chat_tool_grant",
  [AUDIT_RESOURCE_TYPE.CLAUSE]:
    "settings.organization.auditResourceKinds.clause",
  [AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY]:
    "settings.organization.auditResourceKinds.clause_category",
  [AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK]:
    "settings.organization.auditResourceKinds.clause_template_link",
  [AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT]:
    "settings.organization.auditResourceKinds.clause_variant",
  [AUDIT_RESOURCE_TYPE.CONTACT]:
    "settings.organization.auditResourceKinds.contact",
  [AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY]:
    "settings.organization.auditResourceKinds.contact_directory",
  [AUDIT_RESOURCE_TYPE.CORRESPONDENCE]:
    "workspaces.overview.activity.targets.correspondence",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_ANNOTATION]:
    "settings.organization.auditResourceKinds.document_annotation",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE]:
    "settings.organization.auditResourceKinds.document_type",
  [AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION]:
    "settings.organization.auditResourceKinds.usage_allocation",
  [AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT]:
    "settings.organization.auditResourceKinds.usage_entitlement",
  [AUDIT_RESOURCE_TYPE.USAGE_EVENT]:
    "settings.organization.auditResourceKinds.usage_event",
  [AUDIT_RESOURCE_TYPE.USAGE_PROVIDER_EVENT]:
    "settings.organization.auditResourceKinds.usage_provider_event",
  [AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION]:
    "settings.organization.auditResourceKinds.desktop_edit_session",
  [AUDIT_RESOURCE_TYPE.BILINGUAL_TRANSLATION_RUN]:
    "settings.organization.auditResourceKinds.bilingual_translation_run",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TRANSLATION_RUN]:
    "settings.organization.auditResourceKinds.document_translation_run",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN]:
    "settings.organization.auditResourceKinds.document_review_run",
  [AUDIT_RESOURCE_TYPE.ENTITY]:
    "settings.organization.auditResourceKinds.entity",
  [AUDIT_RESOURCE_TYPE.ENTITY_VERSION]:
    "settings.organization.auditResourceKinds.entity_version",
  [AUDIT_RESOURCE_TYPE.EXPENSE]:
    "settings.organization.auditResourceKinds.expense",
  [AUDIT_RESOURCE_TYPE.FEEDBACK_REPORT]:
    "settings.organization.auditResourceKinds.feedback_report",
  [AUDIT_RESOURCE_TYPE.FIELD]: "settings.organization.auditResourceKinds.field",
  [AUDIT_RESOURCE_TYPE.FILE_COMPARISON]:
    "settings.organization.auditResourceKinds.file_comparison",
  [AUDIT_RESOURCE_TYPE.FLOW_DEFINITION]:
    "settings.organization.auditResourceKinds.flow_definition",
  [AUDIT_RESOURCE_TYPE.FLOW_RUN]:
    "settings.organization.auditResourceKinds.flow_run",
  [AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM]:
    "settings.organization.auditResourceKinds.folio_collab_room",
  [AUDIT_RESOURCE_TYPE.SIGNAL]:
    "settings.organization.auditResourceKinds.signal",
  [AUDIT_RESOURCE_TYPE.INVOICE]:
    "settings.organization.auditResourceKinds.invoice",
  [AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY]:
    "settings.organization.auditResourceKinds.personal_api_key",
  [AUDIT_RESOURCE_TYPE.MACHINE_API_KEY]:
    "settings.organization.auditResourceKinds.machine_api_key",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST]:
    "settings.organization.auditResourceKinds.legal_list",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION]:
    "settings.organization.auditResourceKinds.legal_list_generation",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM]:
    "settings.organization.auditResourceKinds.legal_list_item",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION]:
    "settings.organization.auditResourceKinds.legal_list_verification",
  [AUDIT_RESOURCE_TYPE.MCP_CONNECTION]:
    "settings.organization.auditResourceKinds.mcp_connection",
  [AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL]:
    "settings.organization.auditResourceKinds.mcp_gateway_tool",
  [AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE]:
    "settings.organization.auditResourceKinds.organization_access_state",
  [AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS]:
    "settings.organization.auditResourceKinds.organization_settings",
  [AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION]:
    "settings.organization.auditResourceKinds.pdf_signing_session",
  [AUDIT_RESOURCE_TYPE.PLAYBOOK]:
    "settings.organization.auditResourceKinds.playbook",
  [AUDIT_RESOURCE_TYPE.PROPERTY]:
    "settings.organization.auditResourceKinds.property",
  [AUDIT_RESOURCE_TYPE.RATE_ENTRY]:
    "settings.organization.auditResourceKinds.rate_entry",
  [AUDIT_RESOURCE_TYPE.REPORT_EXPORT]:
    "settings.organization.auditResourceKinds.report_export",
  [AUDIT_RESOURCE_TYPE.RATE_TABLE]:
    "settings.organization.auditResourceKinds.rate_table",
  [AUDIT_RESOURCE_TYPE.SAVED_SEARCH]:
    "settings.organization.auditResourceKinds.saved_search",
  [AUDIT_RESOURCE_TYPE.SEARCH_HISTORY]:
    "settings.organization.auditResourceKinds.search_history",
  [AUDIT_RESOURCE_TYPE.SELLER_PROFILE]:
    "settings.organization.auditResourceKinds.seller_profile",
  [AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE]:
    "settings.organization.auditResourceKinds.saved_time_narrative",
  [AUDIT_RESOURCE_TYPE.VAT_RATE]:
    "settings.organization.auditResourceKinds.vat_rate",
  [AUDIT_RESOURCE_TYPE.NUMBER_SERIES]:
    "settings.organization.auditResourceKinds.number_series",
  [AUDIT_RESOURCE_TYPE.STATUTE_ANNOTATION]:
    "settings.organization.auditResourceKinds.statute_annotation",
  [AUDIT_RESOURCE_TYPE.STYLE_SET]:
    "settings.organization.auditResourceKinds.style_set",
  [AUDIT_RESOURCE_TYPE.TEMPLATE]:
    "settings.organization.auditResourceKinds.template",
  [AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT]:
    "settings.organization.auditResourceKinds.template_lookup_format",
  [AUDIT_RESOURCE_TYPE.TIME_ENTRY]:
    "settings.organization.auditResourceKinds.time_entry",
  [AUDIT_RESOURCE_TYPE.TIME_DAILY_TARGET]:
    "settings.organization.auditResourceKinds.time_daily_target",
  [AUDIT_RESOURCE_TYPE.TIME_TIMER]:
    "settings.organization.auditResourceKinds.time_timer",
  [AUDIT_RESOURCE_TYPE.USER_FILE]:
    "settings.organization.auditResourceKinds.user_file",
  [AUDIT_RESOURCE_TYPE.VIEW]: "settings.organization.auditResourceKinds.view",
  [AUDIT_RESOURCE_TYPE.VIEW_TEMPLATE]:
    "settings.organization.auditResourceKinds.view_template",
  [AUDIT_RESOURCE_TYPE.WORKSPACE]:
    "workspaces.overview.activity.targets.matter",
  [AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT]:
    "settings.organization.auditResourceKinds.workspace_contact",
  [AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER]:
    "settings.organization.auditResourceKinds.workspace_member",
  [AUDIT_RESOURCE_TYPE.WORK_OBLIGATION]:
    "settings.organization.auditResourceKinds.work_obligation",
} as const satisfies Record<AuditResourceType, TranslationKey>;

export const isAuditAction = (value: string): value is AuditAction =>
  Object.hasOwn(AUDIT_ACTION_PROJECTIONS, value);

export const isAuditResourceType = (
  value: string,
): value is AuditResourceType =>
  Object.hasOwn(AUDIT_RESOURCE_PROJECTIONS, value);

export const fieldLabel = (field: string) =>
  field
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./u, (letter) => letter.toLocaleUpperCase());

export const projectAuditResourceLabel = ({
  action,
  resource,
  deletedLabel,
  kind,
  unavailableLabel,
}: {
  action: string;
  resource: { kind: AuditResourceType; name: string | null };
  deletedLabel: (kind: string) => string;
  kind: string;
  unavailableLabel: (kind: string) => string;
}) => {
  if (resource.name !== null) {
    return resource.name;
  }
  return action === AUDIT_ACTION.DELETE
    ? deletedLabel(kind)
    : unavailableLabel(kind);
};

export const isUnknownRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

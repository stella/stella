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
  [AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF]: "mcp web handoff",
  [AUDIT_RESOURCE_TYPE.SERVICE_OAUTH_CLIENT]: "service oauth client",
  [AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE]: "legal resolve",
  [AUDIT_RESOURCE_TYPE.AUDIT_LOG]: "audit log",
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL]: "skill",
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT]: "skill comment",
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: "skill proposal",
  [AUDIT_RESOURCE_TYPE.AI_MEMORY]: "ai memory",
  [AUDIT_RESOURCE_TYPE.ANNOUNCEMENT]: "announcement",
  [AUDIT_RESOURCE_TYPE.BILLING_CODE]: "billing code",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK]: "case law matter link",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION]:
    "case law decision annotation",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER]: "case law reader answer",
  [AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN]: "case law research column",
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]: "chat file",
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]: "chat message",
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]: "chat thread",
  [AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION]: "chat tool execution",
  [AUDIT_RESOURCE_TYPE.CHAT_TOOL_GRANT]: "chat tool grant",
  [AUDIT_RESOURCE_TYPE.CLAUSE]: "clause",
  [AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY]: "clause category",
  [AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK]: "clause template link",
  [AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT]: "clause variant",
  [AUDIT_RESOURCE_TYPE.CONTACT]: "contact",
  [AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY]: "contact directory",
  [AUDIT_RESOURCE_TYPE.CORRESPONDENCE]: "correspondence",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_ANNOTATION]: "document annotation",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE]: "document type",
  [AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION]: "usage allocation",
  [AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT]: "usage entitlement",
  [AUDIT_RESOURCE_TYPE.USAGE_EVENT]: "usage event",
  [AUDIT_RESOURCE_TYPE.USAGE_PROVIDER_EVENT]: "usage provider event",
  [AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION]: "desktop edit session",
  [AUDIT_RESOURCE_TYPE.BILINGUAL_TRANSLATION_RUN]: "bilingual translation run",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TRANSLATION_RUN]: "document translation run",
  [AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN]: "document review run",
  [AUDIT_RESOURCE_TYPE.ENTITY]: "item",
  [AUDIT_RESOURCE_TYPE.ENTITY_VERSION]: "entity version",
  [AUDIT_RESOURCE_TYPE.EXPENSE]: "expense",
  [AUDIT_RESOURCE_TYPE.FEEDBACK_REPORT]: "feedback report",
  [AUDIT_RESOURCE_TYPE.FIELD]: "field",
  [AUDIT_RESOURCE_TYPE.FILE_COMPARISON]: "file comparison",
  [AUDIT_RESOURCE_TYPE.FLOW_DEFINITION]: "flow definition",
  [AUDIT_RESOURCE_TYPE.FLOW_RUN]: "flow run",
  [AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM]: "folio collab room",
  [AUDIT_RESOURCE_TYPE.SIGNAL]: "signal",
  [AUDIT_RESOURCE_TYPE.INVOICE]: "invoice",
  [AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY]: "personal api key",
  [AUDIT_RESOURCE_TYPE.MACHINE_API_KEY]: "machine api key",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST]: "legal list",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION]: "legal list generation",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM]: "legal list item",
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION]: "legal list verification",
  [AUDIT_RESOURCE_TYPE.MCP_CONNECTION]: "mcp connection",
  [AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL]: "mcp gateway tool",
  [AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS]: "organization settings",
  [AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION]: "pdf signing session",
  [AUDIT_RESOURCE_TYPE.PLAYBOOK]: "playbook",
  [AUDIT_RESOURCE_TYPE.PROPERTY]: "property",
  [AUDIT_RESOURCE_TYPE.RATE_ENTRY]: "rate entry",
  [AUDIT_RESOURCE_TYPE.REPORT_EXPORT]: "report export",
  [AUDIT_RESOURCE_TYPE.RATE_TABLE]: "rate table",
  [AUDIT_RESOURCE_TYPE.SAVED_SEARCH]: "saved search",
  [AUDIT_RESOURCE_TYPE.SEARCH_HISTORY]: "search history",
  [AUDIT_RESOURCE_TYPE.SELLER_PROFILE]: "seller profile",
  [AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE]: "saved time narrative",
  [AUDIT_RESOURCE_TYPE.VAT_RATE]: "vat rate",
  [AUDIT_RESOURCE_TYPE.NUMBER_SERIES]: "number series",
  [AUDIT_RESOURCE_TYPE.STATUTE_ANNOTATION]: "statute annotation",
  [AUDIT_RESOURCE_TYPE.STYLE_SET]: "style set",
  [AUDIT_RESOURCE_TYPE.TEMPLATE]: "template",
  [AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT]: "template lookup format",
  [AUDIT_RESOURCE_TYPE.TIME_ENTRY]: "time entry",
  [AUDIT_RESOURCE_TYPE.TIME_DAILY_TARGET]: "time daily target",
  [AUDIT_RESOURCE_TYPE.TIME_TIMER]: "time timer",
  [AUDIT_RESOURCE_TYPE.USER_FILE]: "file",
  [AUDIT_RESOURCE_TYPE.VIEW]: "view",
  [AUDIT_RESOURCE_TYPE.VIEW_TEMPLATE]: "view template",
  [AUDIT_RESOURCE_TYPE.WORKSPACE]: "matter",
  [AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT]: "matter contact",
  [AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER]: "matter member",
  [AUDIT_RESOURCE_TYPE.WORK_OBLIGATION]: "work obligation",
} as const satisfies Record<AuditResourceType, string>;

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

export const resourceNameFromChanges = (changes: unknown): string | null => {
  if (!isUnknownRecord(changes)) {
    return null;
  }
  for (const field of ["name", "title", "label"]) {
    const value = changes[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (isUnknownRecord(value)) {
      const next = value["new"];
      if (typeof next === "string" && next.trim()) {
        return next;
      }
      const current = value["value"];
      if (typeof current === "string" && current.trim()) {
        return current;
      }
    }
  }
  return null;
};

export const isUnknownRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const projectAuditResourceLabel = ({
  action,
  changes,
  resourceType,
  deletedLabel,
  unknownLabel,
}: {
  action: string;
  changes: unknown;
  resourceType: string;
  deletedLabel: (kind: string) => string;
  unknownLabel: string;
}) => {
  const kind = isAuditResourceType(resourceType)
    ? AUDIT_RESOURCE_PROJECTIONS[resourceType]
    : unknownLabel;
  const name = resourceNameFromChanges(changes);
  if (name !== null) {
    return name;
  }
  return action === AUDIT_ACTION.DELETE ? deletedLabel(kind) : kind;
};

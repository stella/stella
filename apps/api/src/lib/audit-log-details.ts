import { panic } from "better-result";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";

import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import type { AuditResourceType } from "@/api/lib/audit-log.constants";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type {
  FeatureAccessPrincipal,
  FeatureAccessSnapshot,
} from "@/api/lib/auth/feature-access/policy";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import type { FeatureId } from "@/api/lib/feature-access/registry";

export type ChatAuditResourceType =
  | typeof AUDIT_RESOURCE_TYPE.CHAT_THREAD
  | typeof AUDIT_RESOURCE_TYPE.CHAT_MESSAGE
  | typeof AUDIT_RESOURCE_TYPE.CHAT_FILE;

export type NonChatAuditResourceType = Exclude<
  AuditResourceType,
  ChatAuditResourceType
>;

/** Settings and identifiers of a chat thread; `created`/`deleted` snapshot them. */
const CHAT_THREAD_SETTING_FIELDS = [
  "chatModel",
  "chatReasoningEffort",
  "contextMatterIds",
  "dataWorkspaceIds",
  "titleChanged",
  "titleSource",
  "webSearchEnabled",
  "workspaceId",
] as const;

const CHAT_SNAPSHOT_FIELDS = ["created", "deleted"] as const;

const CHAT_MESSAGE_CHANGE_FIELDS = ["createDocumentDestination"] as const;

/**
 * Change fields an audit entry about a chat resource may carry. Chat payloads
 * come from conversations, so only settings and identifiers are listed here:
 * free text (titles, names, message content) never enters `changes`. Writers
 * are held to these lists by {@link ChatAuditChanges}; entries are also
 * projected onto them when written and when read, so older rows follow the
 * same shape. Snapshots are projected with the same list.
 */
const CHAT_CHANGE_FIELDS = {
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]: new Set<string>([
    ...CHAT_THREAD_SETTING_FIELDS,
    ...CHAT_SNAPSHOT_FIELDS,
  ]),
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]: new Set<string>(
    CHAT_MESSAGE_CHANGE_FIELDS,
  ),
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]: new Set<string>(),
} as const satisfies Record<ChatAuditResourceType, ReadonlySet<string>>;

type AuditDiff = { old: unknown; new: unknown };

type ChatThreadSettings = Partial<
  Record<(typeof CHAT_THREAD_SETTING_FIELDS)[number], unknown>
>;

/** The `changes` each chat resource type accepts. */
export type ChatAuditChanges = {
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]: Partial<
    Record<(typeof CHAT_THREAD_SETTING_FIELDS)[number], AuditDiff>
  > & {
    created?: { old: null; new: ChatThreadSettings };
    deleted?: { old: ChatThreadSettings; new: null };
  };
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]: Partial<
    Record<(typeof CHAT_MESSAGE_CHANGE_FIELDS)[number], AuditDiff>
  >;
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]: Record<string, never>;
};

const isChatResourceType = (
  resourceType: string,
): resourceType is ChatAuditResourceType =>
  Object.hasOwn(CHAT_CHANGE_FIELDS, resourceType);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutTitles = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withoutTitles);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "title")
      .map(([key, nested]) => [key, withoutTitles(nested)]),
  );
};

const onlyListedFields = (
  value: unknown,
  fields: ReadonlySet<string>,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => onlyListedFields(item, fields));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => fields.has(key))
      .map(([key, nested]) => [key, onlyListedFields(nested, fields)]),
  );
};

/** Projects one `{ old, new }` diff: snapshots keep only the listed fields. */
const projectDiff = (diff: unknown, fields: ReadonlySet<string>): unknown => {
  if (!isRecord(diff)) {
    return diff;
  }
  return Object.fromEntries(
    Object.entries(diff)
      .filter(([side]) => side === "old" || side === "new")
      .map(([side, value]) => [side, onlyListedFields(value, fields)]),
  );
};

/** The `changes` an audit entry stores and shows for its resource type. */
export const auditChangesForResource = (
  resourceType: string,
  changes: Record<string, unknown> | null | undefined,
) => {
  if (!changes) {
    return null;
  }
  if (!isChatResourceType(resourceType)) {
    return changes;
  }
  const fields = CHAT_CHANGE_FIELDS[resourceType];
  return Object.fromEntries(
    Object.entries(changes)
      .filter(([key]) => fields.has(key))
      .map(([key, diff]) => [key, projectDiff(diff, fields)]),
  );
};

/** The request and event `metadata` an audit entry stores. */
export const auditMetadataForResource = (
  resourceType: string,
  details: Record<string, unknown> | null | undefined,
) => {
  if (!details) {
    return null;
  }
  if (resourceType !== AUDIT_RESOURCE_TYPE.CHAT_THREAD) {
    return details;
  }
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => key !== "title")
      .map(([key, value]) => [key, withoutTitles(value)]),
  );
};

type AuditDetailPolicy =
  | { type: "ungated" }
  | { type: "caller-feature"; featureId: FeatureId }
  | { type: "deployment-feature"; feature: DeploymentFeatureFlag };

type AuditResourceDetailPolicy = {
  default: AuditDetailPolicy;
  operations: Readonly<Record<string, AuditDetailPolicy>>;
};

const UNGATED_AUDIT_DETAILS = {
  default: { type: "ungated" },
  operations: {},
} as const;
const TIME_BILLING_AUDIT_DETAILS = {
  default: { type: "caller-feature", featureId: "time-billing" },
  operations: {},
} as const satisfies AuditResourceDetailPolicy;
const VERIFICATION_AUDIT_DETAILS = {
  type: "caller-feature",
  featureId: LIST_VERIFICATION_FEATURE_ID,
} as const satisfies AuditDetailPolicy;

/** Every new audit resource requires an explicit detail policy. */
export const AUDIT_DETAIL_POLICY = {
  [AUDIT_RESOURCE_TYPE.AUDIT_LOG]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.AI_MEMORY]: {
    default: { type: "deployment-feature", feature: "FEATURE_AI_MEMORY" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.ANNOUNCEMENT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.BILLING_CODE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CLAUSE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CONTACT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.CORRESPONDENCE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION]: {
    default: { type: "deployment-feature", feature: "FEATURE_USAGE" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT]: {
    default: { type: "deployment-feature", feature: "FEATURE_USAGE" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.USAGE_EVENT]: {
    default: { type: "deployment-feature", feature: "FEATURE_USAGE" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.USAGE_PROVIDER_EVENT]: {
    default: { type: "deployment-feature", feature: "FEATURE_USAGE" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.BILINGUAL_TRANSLATION_RUN]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TRANSLATION_RUN]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.ENTITY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.ENTITY_VERSION]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.EXPENSE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.FEEDBACK_REPORT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.FIELD]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.FILE_COMPARISON]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.FLOW_DEFINITION]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.FLOW_RUN]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.SIGNAL]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.INVOICE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.MACHINE_API_KEY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST]: {
    default: { type: "deployment-feature", feature: "FEATURE_LEGAL_LISTS" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION]: {
    default: { type: "deployment-feature", feature: "FEATURE_LEGAL_LISTS" },
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM]: {
    default: { type: "deployment-feature", feature: "FEATURE_LEGAL_LISTS" },
    operations: {
      fact_details_set: VERIFICATION_AUDIT_DETAILS,
      source_verification_changed: VERIFICATION_AUDIT_DETAILS,
    },
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION]: {
    default: VERIFICATION_AUDIT_DETAILS,
    operations: {},
  },
  [AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.PLAYBOOK]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.PROPERTY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.RATE_ENTRY]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.REPORT_EXPORT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.RATE_TABLE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.SAVED_SEARCH]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.SEARCH_HISTORY]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.SELLER_PROFILE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.VAT_RATE]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.NUMBER_SERIES]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.STATUTE_ANNOTATION]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.STYLE_SET]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.TEMPLATE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.TIME_ENTRY]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.TIME_DAILY_TARGET]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.TIME_TIMER]: TIME_BILLING_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.USER_FILE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.VIEW]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.VIEW_TEMPLATE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.WORKSPACE]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER]: UNGATED_AUDIT_DETAILS,
  [AUDIT_RESOURCE_TYPE.WORK_OBLIGATION]: {
    default: {
      type: "deployment-feature",
      feature: "FEATURE_GOVERNED_WORKFLOW",
    },
    operations: {},
  },
} as const satisfies Record<AuditResourceType, AuditResourceDetailPolicy>;

type AuditReadChanges =
  | {
      changesStatus: typeof AUDIT_CHANGES_STATUS.visible;
      changes: Record<string, unknown> | null;
    }
  | {
      changesStatus: typeof AUDIT_CHANGES_STATUS.featureUnavailable;
      changes: null;
    };

type ProjectAuditReadChangesOptions = {
  resourceType: string;
  changes: Record<string, unknown> | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
  principal: FeatureAccessPrincipal;
};

const isClassifiedAuditResource = (
  resourceType: string,
): resourceType is AuditResourceType =>
  Object.hasOwn(AUDIT_DETAIL_POLICY, resourceType);

type AuditPolicyEnabledOptions = {
  policy: AuditDetailPolicy;
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
  principal: FeatureAccessPrincipal;
};

const isAuditPolicyEnabled = ({
  policy,
  featureAccessSnapshot,
  principal,
}: AuditPolicyEnabledOptions) => {
  switch (policy.type) {
    case "ungated":
      return true;
    case "caller-feature":
      return (
        featureAccessSnapshot !== undefined &&
        isFeatureEnabled(featureAccessSnapshot, policy.featureId, principal)
      );
    case "deployment-feature":
      return isDeploymentFeatureEnabled(policy.feature);
    default:
      policy satisfies never;
      return panic("Audit detail policy requires a supported type");
  }
};

/** Read projection shared by audit pages and exports; stored details remain intact. */
export const projectAuditReadChanges = ({
  resourceType,
  changes,
  metadata,
  featureAccessSnapshot,
  principal,
}: ProjectAuditReadChangesOptions): AuditReadChanges => {
  if (!isClassifiedAuditResource(resourceType)) {
    return panic("Audit resource requires a detail policy");
  }
  const resourcePolicy = AUDIT_DETAIL_POLICY[resourceType];
  const operationPolicy = Object.entries(resourcePolicy.operations).find(
    ([operation]) => operation === metadata?.["operation"],
  )?.[1];
  const enabled =
    isAuditPolicyEnabled({
      policy: resourcePolicy.default,
      featureAccessSnapshot,
      principal,
    }) &&
    (operationPolicy === undefined ||
      isAuditPolicyEnabled({
        policy: operationPolicy,
        featureAccessSnapshot,
        principal,
      }));
  if (!enabled) {
    return {
      changesStatus: AUDIT_CHANGES_STATUS.featureUnavailable,
      changes: null,
    };
  }
  return {
    changesStatus: AUDIT_CHANGES_STATUS.visible,
    changes: auditChangesForResource(resourceType, changes),
  };
};

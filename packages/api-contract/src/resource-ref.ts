import * as v from "valibot";

import { encodeRfc3986Component } from "./rfc3986";
import { isSafeIdValue, toSafeId, type SafeId } from "./safe-id";

/** Stable product nouns. Presentation labels and storage table names may differ. */
export const RESOURCE_TYPE = {
  AGENT_SKILL: "agent_skill",
  AGENT_SKILL_COMMENT: "agent_skill_comment",
  AGENT_SKILL_PROPOSAL: "agent_skill_proposal",
  AGENT_SKILL_RESOURCE: "agent_skill_resource",
  AGENT_SKILL_REVISION: "agent_skill_revision",
  AI_MEMORY: "ai_memory",
  BILLING_CODE: "billing_code",
  CASE_LAW_DECISION: "case_law_decision",
  CASE_LAW_SOURCE: "case_law_source",
  CHAT_MESSAGE: "chat_message",
  CHAT_THREAD: "chat_thread",
  CLAUSE: "clause",
  CLAUSE_CATEGORY: "clause_category",
  CLAUSE_VARIANT: "clause_variant",
  CLAUSE_VERSION: "clause_version",
  CONTACT: "contact",
  DOCUMENT_TYPE: "document_type",
  ENTITY: "entity",
  ENTITY_VERSION: "entity_version",
  EXPENSE: "expense",
  FIELD: "field",
  FLOW_DEFINITION: "flow_definition",
  FLOW_RUN: "flow_run",
  INVOICE: "invoice",
  LEGAL_LIST: "legal_list",
  LEGISLATION_DOCUMENT: "legislation_document",
  LEGISLATION_SOURCE: "legislation_source",
  MCP_CONNECTOR: "mcp_connector",
  ORGANIZATION: "organization",
  PLAYBOOK: "playbook",
  PLAYBOOK_VERSION: "playbook_version",
  PROPERTY: "property",
  RATE_ENTRY: "rate_entry",
  RATE_TABLE: "rate_table",
  REPORT_EXPORT: "report_export",
  SAVED_SEARCH: "saved_search",
  STYLE_SET: "style_set",
  TEMPLATE: "template",
  TEMPLATE_CATEGORY: "template_category",
  TEMPLATE_VERSION: "template_version",
  TIME_ENTRY: "time_entry",
  USER: "user",
  USER_FILE: "user_file",
  WORKSPACE: "workspace",
  WORKSPACE_VIEW: "workspace_view",
  WORKSPACE_VIEW_TEMPLATE: "workspace_view_template",
} as const;

export type ResourceType = (typeof RESOURCE_TYPE)[keyof typeof RESOURCE_TYPE];

/**
 * The identifier brand owned by each resource type. This is the only mapping
 * between the stable resource vocabulary and storage-facing ID vocabulary.
 */
export const RESOURCE_ID_TYPE = {
  [RESOURCE_TYPE.AGENT_SKILL]: "agentSkill",
  [RESOURCE_TYPE.AGENT_SKILL_COMMENT]: "agentSkillComment",
  [RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: "agentSkillProposal",
  [RESOURCE_TYPE.AGENT_SKILL_RESOURCE]: "agentSkillResource",
  [RESOURCE_TYPE.AGENT_SKILL_REVISION]: "agentSkillRevision",
  [RESOURCE_TYPE.AI_MEMORY]: "aiMemory",
  [RESOURCE_TYPE.BILLING_CODE]: "billingCode",
  [RESOURCE_TYPE.CASE_LAW_DECISION]: "caseLawDecision",
  [RESOURCE_TYPE.CASE_LAW_SOURCE]: "caseLawSource",
  [RESOURCE_TYPE.CHAT_MESSAGE]: "chatMessage",
  [RESOURCE_TYPE.CHAT_THREAD]: "chatThread",
  [RESOURCE_TYPE.CLAUSE]: "clause",
  [RESOURCE_TYPE.CLAUSE_CATEGORY]: "clauseCategory",
  [RESOURCE_TYPE.CLAUSE_VARIANT]: "clauseVariant",
  [RESOURCE_TYPE.CLAUSE_VERSION]: "clauseVersion",
  [RESOURCE_TYPE.CONTACT]: "contact",
  [RESOURCE_TYPE.DOCUMENT_TYPE]: "documentType",
  [RESOURCE_TYPE.ENTITY]: "entity",
  [RESOURCE_TYPE.ENTITY_VERSION]: "entityVersion",
  [RESOURCE_TYPE.EXPENSE]: "expense",
  [RESOURCE_TYPE.FIELD]: "field",
  [RESOURCE_TYPE.FLOW_DEFINITION]: "flowDefinition",
  [RESOURCE_TYPE.FLOW_RUN]: "flowRun",
  [RESOURCE_TYPE.INVOICE]: "invoice",
  [RESOURCE_TYPE.LEGAL_LIST]: "legalList",
  [RESOURCE_TYPE.LEGISLATION_DOCUMENT]: "legislationDocument",
  [RESOURCE_TYPE.LEGISLATION_SOURCE]: "legislationSource",
  [RESOURCE_TYPE.MCP_CONNECTOR]: "mcpConnector",
  [RESOURCE_TYPE.ORGANIZATION]: "organization",
  [RESOURCE_TYPE.PLAYBOOK]: "playbookDefinition",
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: "playbookDefinitionVersion",
  [RESOURCE_TYPE.PROPERTY]: "property",
  [RESOURCE_TYPE.RATE_ENTRY]: "rateEntry",
  [RESOURCE_TYPE.RATE_TABLE]: "rateTable",
  [RESOURCE_TYPE.REPORT_EXPORT]: "reportExport",
  [RESOURCE_TYPE.SAVED_SEARCH]: "savedSearch",
  [RESOURCE_TYPE.STYLE_SET]: "styleSet",
  [RESOURCE_TYPE.TEMPLATE]: "template",
  [RESOURCE_TYPE.TEMPLATE_CATEGORY]: "templateCategory",
  [RESOURCE_TYPE.TEMPLATE_VERSION]: "templateVersion",
  [RESOURCE_TYPE.TIME_ENTRY]: "timeEntry",
  [RESOURCE_TYPE.USER]: "user",
  [RESOURCE_TYPE.USER_FILE]: "userFile",
  [RESOURCE_TYPE.WORKSPACE]: "workspace",
  [RESOURCE_TYPE.WORKSPACE_VIEW]: "workspaceView",
  [RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE]: "workspaceViewTemplate",
} as const satisfies Record<ResourceType, string>;

type ResourceRefBranch<TType extends ResourceType> = {
  readonly type: TType;
  readonly id: SafeId<(typeof RESOURCE_ID_TYPE)[TType]>;
};

export type ResourceRef<TType extends ResourceType = ResourceType> =
  TType extends ResourceType ? ResourceRefBranch<TType> : never;

export const resourceRef = <TResource extends ResourceRef>({
  type,
  id,
}: TResource): {
  readonly type: TResource["type"];
  readonly id: TResource["id"];
} => ({ type, id });

export const isResourceType = (value: unknown): value is ResourceType =>
  typeof value === "string" && Object.hasOwn(RESOURCE_ID_TYPE, value);

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isResourceRef = (value: unknown): value is ResourceRef => {
  if (!isUnknownRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "type") ||
    !Object.hasOwn(value, "id")
  ) {
    return false;
  }
  const type = value["type"];
  const id = value["id"];
  return isResourceType(type) && typeof id === "string" && isSafeIdValue(id);
};

const resourceRefSchema = v.custom<ResourceRef>(isResourceRef);

export const parseResourceRef = (input: unknown): ResourceRef | null => {
  const result = v.safeParse(resourceRefSchema, input);
  if (!result.success) {
    return null;
  }
  return result.output;
};

export const RESOURCE_NAME_PREFIX = "stella://resource/" as const;
const RESOURCE_NAME_ID_SEGMENT_PREFIX = "id=" as const;

const resourceNameSchema = v.pipe(v.string(), v.brand("ResourceName"));

export type ResourceName = v.InferOutput<typeof resourceNameSchema>;

/** A route-independent durable serialization of a resource identity. */
export const toResourceName = (resource: ResourceRef): ResourceName =>
  v.parse(
    resourceNameSchema,
    `${RESOURCE_NAME_PREFIX}${resource.type}/${RESOURCE_NAME_ID_SEGMENT_PREFIX}${encodeRfc3986Component(resource.id)}`,
  );

/** Parse only complete canonical names; aliases and UI routes belong elsewhere. */
export const parseResourceName = (input: unknown): ResourceRef | null => {
  if (typeof input !== "string" || !input.startsWith(RESOURCE_NAME_PREFIX)) {
    return null;
  }

  const path = input.slice(RESOURCE_NAME_PREFIX.length);
  const separatorIndex = path.indexOf("/");
  if (
    separatorIndex <= 0 ||
    separatorIndex === path.length - 1 ||
    path.includes("/", separatorIndex + 1)
  ) {
    return null;
  }

  const type = path.slice(0, separatorIndex);
  if (!isResourceType(type)) {
    return null;
  }

  const idSegment = path.slice(separatorIndex + 1);
  if (!idSegment.startsWith(RESOURCE_NAME_ID_SEGMENT_PREFIX)) {
    return null;
  }

  const encodedId = idSegment.slice(RESOURCE_NAME_ID_SEGMENT_PREFIX.length);
  if (encodedId.length === 0) {
    return null;
  }
  try {
    const id = decodeURIComponent(encodedId);
    if (!isSafeIdValue(id)) {
      return null;
    }
    const resource = parseResourceRef({ type, id: toSafeId(id) });
    return resource !== null && toResourceName(resource) === input
      ? resource
      : null;
  } catch {
    // Boundary parser: malformed percent encoding is an invalid resource name.
    return null;
  }
};

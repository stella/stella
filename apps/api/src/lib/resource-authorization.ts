import { RESOURCE_TYPE } from "@stll/api-contract";
import type { ResourceRef, ResourceType } from "@stll/api-contract";

type ResourceAuthorizationOwner =
  | "agent_skills"
  | "billing"
  | "case_law"
  | "chat"
  | "clauses"
  | "contacts"
  | "document_types"
  | "entities"
  | "expenses"
  | "flows"
  | "invoices"
  | "legal_lists"
  | "legislation"
  | "mcp_connectors"
  | "organization"
  | "playbooks"
  | "properties"
  | "rates"
  | "reports"
  | "saved_searches"
  | "style_sets"
  | "templates"
  | "time_entries"
  | "user_files"
  | "workspaces";

type ResourceAuthorizationDisposition =
  | { type: "domain_policy"; owner: ResourceAuthorizationOwner }
  | {
      /** Availability is decided per corpus record and source policy. */
      type: "corpus_policy";
      owner: Extract<ResourceAuthorizationOwner, "case_law" | "legislation">;
    };

/**
 * Total dispatch to the domain that owns each access decision. A ResourceRef
 * identifies a target; it never proves that a caller may read or mutate it.
 */
export const RESOURCE_AUTHORIZATION_DISPOSITION = {
  [RESOURCE_TYPE.AGENT_SKILL]: { type: "domain_policy", owner: "agent_skills" },
  [RESOURCE_TYPE.AGENT_SKILL_COMMENT]: {
    type: "domain_policy",
    owner: "agent_skills",
  },
  [RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: {
    type: "domain_policy",
    owner: "agent_skills",
  },
  [RESOURCE_TYPE.AGENT_SKILL_RESOURCE]: {
    type: "domain_policy",
    owner: "agent_skills",
  },
  [RESOURCE_TYPE.AGENT_SKILL_REVISION]: {
    type: "domain_policy",
    owner: "agent_skills",
  },
  [RESOURCE_TYPE.AI_MEMORY]: { type: "domain_policy", owner: "organization" },
  [RESOURCE_TYPE.BILLING_CODE]: { type: "domain_policy", owner: "billing" },
  [RESOURCE_TYPE.CASE_LAW_DECISION]: {
    type: "corpus_policy",
    owner: "case_law",
  },
  [RESOURCE_TYPE.CASE_LAW_SOURCE]: {
    type: "domain_policy",
    owner: "case_law",
  },
  [RESOURCE_TYPE.CHAT_MESSAGE]: { type: "domain_policy", owner: "chat" },
  [RESOURCE_TYPE.CHAT_THREAD]: { type: "domain_policy", owner: "chat" },
  [RESOURCE_TYPE.CLAUSE]: { type: "domain_policy", owner: "clauses" },
  [RESOURCE_TYPE.CLAUSE_CATEGORY]: {
    type: "domain_policy",
    owner: "clauses",
  },
  [RESOURCE_TYPE.CLAUSE_VARIANT]: {
    type: "domain_policy",
    owner: "clauses",
  },
  [RESOURCE_TYPE.CLAUSE_VERSION]: {
    type: "domain_policy",
    owner: "clauses",
  },
  [RESOURCE_TYPE.CONTACT]: { type: "domain_policy", owner: "contacts" },
  [RESOURCE_TYPE.DOCUMENT_TYPE]: {
    type: "domain_policy",
    owner: "document_types",
  },
  [RESOURCE_TYPE.ENTITY]: { type: "domain_policy", owner: "entities" },
  [RESOURCE_TYPE.ENTITY_VERSION]: {
    type: "domain_policy",
    owner: "entities",
  },
  [RESOURCE_TYPE.EXPENSE]: { type: "domain_policy", owner: "expenses" },
  [RESOURCE_TYPE.FIELD]: { type: "domain_policy", owner: "entities" },
  [RESOURCE_TYPE.FLOW_DEFINITION]: { type: "domain_policy", owner: "flows" },
  [RESOURCE_TYPE.FLOW_RUN]: { type: "domain_policy", owner: "flows" },
  [RESOURCE_TYPE.INVOICE]: { type: "domain_policy", owner: "invoices" },
  [RESOURCE_TYPE.LEGAL_LIST]: { type: "domain_policy", owner: "legal_lists" },
  [RESOURCE_TYPE.LEGISLATION_DOCUMENT]: {
    type: "corpus_policy",
    owner: "legislation",
  },
  [RESOURCE_TYPE.LEGISLATION_SOURCE]: {
    type: "domain_policy",
    owner: "legislation",
  },
  [RESOURCE_TYPE.MCP_CONNECTOR]: {
    type: "domain_policy",
    owner: "mcp_connectors",
  },
  [RESOURCE_TYPE.ORGANIZATION]: {
    type: "domain_policy",
    owner: "organization",
  },
  [RESOURCE_TYPE.PLAYBOOK]: { type: "domain_policy", owner: "playbooks" },
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: {
    type: "domain_policy",
    owner: "playbooks",
  },
  [RESOURCE_TYPE.PROPERTY]: { type: "domain_policy", owner: "properties" },
  [RESOURCE_TYPE.RATE_ENTRY]: { type: "domain_policy", owner: "rates" },
  [RESOURCE_TYPE.RATE_TABLE]: { type: "domain_policy", owner: "rates" },
  [RESOURCE_TYPE.REPORT_EXPORT]: { type: "domain_policy", owner: "reports" },
  [RESOURCE_TYPE.SAVED_SEARCH]: {
    type: "domain_policy",
    owner: "saved_searches",
  },
  [RESOURCE_TYPE.STYLE_SET]: { type: "domain_policy", owner: "style_sets" },
  [RESOURCE_TYPE.TEMPLATE]: { type: "domain_policy", owner: "templates" },
  [RESOURCE_TYPE.TEMPLATE_CATEGORY]: {
    type: "domain_policy",
    owner: "templates",
  },
  [RESOURCE_TYPE.TEMPLATE_VERSION]: {
    type: "domain_policy",
    owner: "templates",
  },
  [RESOURCE_TYPE.TIME_ENTRY]: { type: "domain_policy", owner: "time_entries" },
  [RESOURCE_TYPE.USER]: { type: "domain_policy", owner: "organization" },
  [RESOURCE_TYPE.USER_FILE]: { type: "domain_policy", owner: "user_files" },
  [RESOURCE_TYPE.WORKSPACE]: { type: "domain_policy", owner: "workspaces" },
  [RESOURCE_TYPE.WORKSPACE_VIEW]: {
    type: "domain_policy",
    owner: "workspaces",
  },
  [RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE]: {
    type: "domain_policy",
    owner: "workspaces",
  },
} as const satisfies Record<ResourceType, ResourceAuthorizationDisposition>;

export const getResourceAuthorizationDisposition = (resource: ResourceRef) =>
  RESOURCE_AUTHORIZATION_DISPOSITION[resource.type];

import { RESOURCE_TYPE } from "@stll/api-contract";
import type { ResourceRef, ResourceType } from "@stll/api-contract";

type BacklinkOwner =
  | "case_law_matter_links"
  | "entity_links"
  | "template_clauses"
  | "workspace_contacts";

type BacklinkDisposition =
  | { type: "supported"; owners: readonly BacklinkOwner[] }
  | { type: "unsupported" };

const UNSUPPORTED = { type: "unsupported" } as const;

/**
 * Total routing policy for relationship lookups. Owning slices keep their own
 * authorization and query logic; this registry only declares where backlinks
 * exist, so identity does not become a generic fetch bypass.
 */
export const RESOURCE_BACKLINK_DISPOSITION = {
  [RESOURCE_TYPE.AGENT_SKILL]: UNSUPPORTED,
  [RESOURCE_TYPE.AGENT_SKILL_COMMENT]: UNSUPPORTED,
  [RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: UNSUPPORTED,
  [RESOURCE_TYPE.AGENT_SKILL_RESOURCE]: UNSUPPORTED,
  [RESOURCE_TYPE.AGENT_SKILL_REVISION]: UNSUPPORTED,
  [RESOURCE_TYPE.AI_MEMORY]: UNSUPPORTED,
  [RESOURCE_TYPE.BILLING_CODE]: UNSUPPORTED,
  [RESOURCE_TYPE.CASE_LAW_DECISION]: {
    type: "supported",
    owners: ["case_law_matter_links"],
  },
  [RESOURCE_TYPE.CASE_LAW_SOURCE]: UNSUPPORTED,
  [RESOURCE_TYPE.CHAT_MESSAGE]: UNSUPPORTED,
  [RESOURCE_TYPE.CHAT_THREAD]: UNSUPPORTED,
  [RESOURCE_TYPE.CLAUSE]: {
    type: "supported",
    owners: ["template_clauses"],
  },
  [RESOURCE_TYPE.CLAUSE_CATEGORY]: UNSUPPORTED,
  [RESOURCE_TYPE.CLAUSE_VARIANT]: UNSUPPORTED,
  [RESOURCE_TYPE.CLAUSE_VERSION]: UNSUPPORTED,
  [RESOURCE_TYPE.CONTACT]: {
    type: "supported",
    owners: ["workspace_contacts"],
  },
  [RESOURCE_TYPE.DOCUMENT_TYPE]: UNSUPPORTED,
  [RESOURCE_TYPE.ENTITY]: { type: "supported", owners: ["entity_links"] },
  [RESOURCE_TYPE.ENTITY_VERSION]: UNSUPPORTED,
  [RESOURCE_TYPE.EXPENSE]: UNSUPPORTED,
  [RESOURCE_TYPE.FIELD]: UNSUPPORTED,
  [RESOURCE_TYPE.FLOW_DEFINITION]: UNSUPPORTED,
  [RESOURCE_TYPE.FLOW_RUN]: UNSUPPORTED,
  [RESOURCE_TYPE.INVOICE]: UNSUPPORTED,
  [RESOURCE_TYPE.LEGAL_LIST]: UNSUPPORTED,
  [RESOURCE_TYPE.LEGISLATION_DOCUMENT]: UNSUPPORTED,
  [RESOURCE_TYPE.LEGISLATION_SOURCE]: UNSUPPORTED,
  [RESOURCE_TYPE.MCP_CONNECTOR]: UNSUPPORTED,
  [RESOURCE_TYPE.ORGANIZATION]: UNSUPPORTED,
  [RESOURCE_TYPE.PLAYBOOK]: UNSUPPORTED,
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: UNSUPPORTED,
  [RESOURCE_TYPE.PROPERTY]: UNSUPPORTED,
  [RESOURCE_TYPE.RATE_ENTRY]: UNSUPPORTED,
  [RESOURCE_TYPE.RATE_TABLE]: UNSUPPORTED,
  [RESOURCE_TYPE.REPORT_EXPORT]: UNSUPPORTED,
  [RESOURCE_TYPE.SAVED_SEARCH]: UNSUPPORTED,
  [RESOURCE_TYPE.STYLE_SET]: UNSUPPORTED,
  [RESOURCE_TYPE.TEMPLATE]: {
    type: "supported",
    owners: ["template_clauses"],
  },
  [RESOURCE_TYPE.TEMPLATE_CATEGORY]: UNSUPPORTED,
  [RESOURCE_TYPE.TEMPLATE_VERSION]: UNSUPPORTED,
  [RESOURCE_TYPE.TIME_ENTRY]: UNSUPPORTED,
  [RESOURCE_TYPE.USER]: UNSUPPORTED,
  [RESOURCE_TYPE.USER_FILE]: UNSUPPORTED,
  [RESOURCE_TYPE.WORKSPACE]: {
    type: "supported",
    owners: ["case_law_matter_links", "workspace_contacts"],
  },
  [RESOURCE_TYPE.WORKSPACE_VIEW]: UNSUPPORTED,
  [RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE]: UNSUPPORTED,
} as const satisfies Record<ResourceType, BacklinkDisposition>;

export const getResourceBacklinkDisposition = (resource: ResourceRef) =>
  RESOURCE_BACKLINK_DISPOSITION[resource.type];

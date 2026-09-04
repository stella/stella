import { hashKey, type QueryKey } from "@tanstack/react-query";
import { panic } from "better-result";

import {
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  RESOURCE_CHANGE_TYPE,
  RESOURCE_TYPE,
  type ResourceChange,
  type ResourceType,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

import {
  fileContentByFieldQueryRoot,
  fileMetadataByFieldQueryRoot,
  filesQueryRoot,
} from "@/lib/files/file-metadata-query.logic";
import {
  agentSkillsQueryRoot,
  billingCodesQueryRoot,
  catalogueQueryRoot,
  contactsQueryRoot,
  expensesQueryRoot,
  flowRunsQueryRoot,
  invoicesQueryRoot,
  legalListsQueryRoot,
  mcpQueryRoot,
  organizationQueryRoot,
  organizationSettingsQueryRoot,
  propertiesQueryRoot,
  ratesQueryRoot,
  tasksQueryRoot,
  timeEntriesQueryRoot,
  workspaceAnonymizationAllowlistQueryRoot,
  workspaceAnonymizationTermsQueryRoot,
  workspaceContactsQueryRoot,
  workspaceMembersQueryRoot,
} from "@/lib/resource-query-roots.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { viewsRootKey } from "@/lib/workspaces/queries/views.logic";
import {
  workspaceJustificationsQueryRoot,
  workspaceWorkflowQueryRoot,
} from "@/lib/workspaces/queries/workspace.logic";

export const parseWorkspaceRealtimeMessage = (
  data: string,
): WorkspaceRealtimeEvent | null => {
  try {
    return parseWorkspaceRealtimeEvent(JSON.parse(data));
  } catch {
    return null;
  }
};

export const WORKSPACE_REALTIME_QUERY_ACTION = {
  INVALIDATE: "invalidate",
  REMOVE_PREFIX: "remove_prefix",
} as const;

export type WorkspaceRealtimeQueryAction =
  | {
      type: typeof WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE;
      queryKey: QueryKey;
    }
  | {
      type: typeof WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX;
      queryKey: QueryKey;
    };

const RESOURCE_QUERY_SCOPE = {
  ANONYMIZATION: "anonymization",
  BILLING_CODES: "billing_codes",
  CONTACTS: "contacts",
  ENTITIES: "entities",
  EXPENSES: "expenses",
  FILES: "files",
  FLOW_RUNS: "flow_runs",
  FLOW_STATE: "flow_state",
  INVOICES: "invoices",
  JUSTIFICATIONS: "justifications",
  LEGAL_LISTS: "legal_lists",
  MCP: "mcp",
  ORGANIZATION: "organization",
  PROPERTIES: "properties",
  RATES: "rates",
  SKILLS: "skills",
  TASKS: "tasks",
  TIME_ENTRIES: "time_entries",
  VIEWS: "views",
  WORKSPACE_CONTACTS: "workspace_contacts",
  WORKSPACE_MEMBERS: "workspace_members",
  WORKSPACE_OVERVIEW: "workspace_overview",
  WORKSPACES: "workspaces",
} as const;

type ResourceQueryScope =
  (typeof RESOURCE_QUERY_SCOPE)[keyof typeof RESOURCE_QUERY_SCOPE];

/** Every resource type must explicitly choose its web-cache behavior. */
const RESOURCE_REALTIME_QUERY_POLICY = {
  [RESOURCE_TYPE.AGENT_SKILL]: [RESOURCE_QUERY_SCOPE.SKILLS],
  [RESOURCE_TYPE.AGENT_SKILL_COMMENT]: [RESOURCE_QUERY_SCOPE.SKILLS],
  [RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: [RESOURCE_QUERY_SCOPE.SKILLS],
  [RESOURCE_TYPE.AGENT_SKILL_RESOURCE]: [RESOURCE_QUERY_SCOPE.SKILLS],
  [RESOURCE_TYPE.AGENT_SKILL_REVISION]: [RESOURCE_QUERY_SCOPE.SKILLS],
  [RESOURCE_TYPE.AI_MEMORY]: [],
  [RESOURCE_TYPE.BILLING_CODE]: [RESOURCE_QUERY_SCOPE.BILLING_CODES],
  [RESOURCE_TYPE.CASE_LAW_DECISION]: [],
  [RESOURCE_TYPE.CASE_LAW_SOURCE]: [],
  [RESOURCE_TYPE.CHAT_MESSAGE]: [],
  [RESOURCE_TYPE.CHAT_THREAD]: [],
  [RESOURCE_TYPE.CLAUSE]: [],
  [RESOURCE_TYPE.CLAUSE_CATEGORY]: [],
  [RESOURCE_TYPE.CLAUSE_VARIANT]: [],
  [RESOURCE_TYPE.CLAUSE_VERSION]: [],
  [RESOURCE_TYPE.CONTACT]: [RESOURCE_QUERY_SCOPE.CONTACTS],
  [RESOURCE_TYPE.DOCUMENT_TYPE]: [],
  [RESOURCE_TYPE.ENTITY]: [
    RESOURCE_QUERY_SCOPE.ENTITIES,
    RESOURCE_QUERY_SCOPE.TASKS,
    RESOURCE_QUERY_SCOPE.WORKSPACE_OVERVIEW,
  ],
  [RESOURCE_TYPE.ENTITY_VERSION]: [RESOURCE_QUERY_SCOPE.ENTITIES],
  [RESOURCE_TYPE.EXPENSE]: [RESOURCE_QUERY_SCOPE.EXPENSES],
  [RESOURCE_TYPE.FIELD]: [RESOURCE_QUERY_SCOPE.ENTITIES],
  [RESOURCE_TYPE.FLOW_DEFINITION]: [],
  [RESOURCE_TYPE.FLOW_RUN]: [
    RESOURCE_QUERY_SCOPE.FLOW_RUNS,
    RESOURCE_QUERY_SCOPE.FLOW_STATE,
    RESOURCE_QUERY_SCOPE.ENTITIES,
  ],
  [RESOURCE_TYPE.INVOICE]: [
    RESOURCE_QUERY_SCOPE.INVOICES,
    RESOURCE_QUERY_SCOPE.TIME_ENTRIES,
    RESOURCE_QUERY_SCOPE.EXPENSES,
  ],
  [RESOURCE_TYPE.LEGAL_LIST]: [RESOURCE_QUERY_SCOPE.LEGAL_LISTS],
  [RESOURCE_TYPE.LEGISLATION_DOCUMENT]: [],
  [RESOURCE_TYPE.LEGISLATION_SOURCE]: [],
  [RESOURCE_TYPE.MCP_CONNECTOR]: [RESOURCE_QUERY_SCOPE.MCP],
  [RESOURCE_TYPE.ORGANIZATION]: [RESOURCE_QUERY_SCOPE.ORGANIZATION],
  [RESOURCE_TYPE.PLAYBOOK]: [],
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: [],
  [RESOURCE_TYPE.PROPERTY]: [RESOURCE_QUERY_SCOPE.PROPERTIES],
  [RESOURCE_TYPE.RATE_ENTRY]: [RESOURCE_QUERY_SCOPE.RATES],
  [RESOURCE_TYPE.RATE_TABLE]: [RESOURCE_QUERY_SCOPE.RATES],
  [RESOURCE_TYPE.REPORT_EXPORT]: [],
  [RESOURCE_TYPE.SAVED_SEARCH]: [],
  [RESOURCE_TYPE.STYLE_SET]: [],
  [RESOURCE_TYPE.TEMPLATE]: [],
  [RESOURCE_TYPE.TEMPLATE_CATEGORY]: [],
  [RESOURCE_TYPE.TEMPLATE_VERSION]: [],
  [RESOURCE_TYPE.TIME_ENTRY]: [RESOURCE_QUERY_SCOPE.TIME_ENTRIES],
  [RESOURCE_TYPE.USER]: [],
  [RESOURCE_TYPE.USER_FILE]: [RESOURCE_QUERY_SCOPE.FILES],
  [RESOURCE_TYPE.WORKSPACE]: [
    RESOURCE_QUERY_SCOPE.WORKSPACES,
    RESOURCE_QUERY_SCOPE.WORKSPACE_MEMBERS,
    RESOURCE_QUERY_SCOPE.WORKSPACE_CONTACTS,
    RESOURCE_QUERY_SCOPE.ANONYMIZATION,
    RESOURCE_QUERY_SCOPE.JUSTIFICATIONS,
  ],
  [RESOURCE_TYPE.WORKSPACE_VIEW]: [RESOURCE_QUERY_SCOPE.VIEWS],
  [RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE]: [],
} as const satisfies Record<ResourceType, readonly ResourceQueryScope[]>;

const getResourceQueryScopeKeys = (
  scope: ResourceQueryScope,
  workspaceId: string,
): QueryKey[] => {
  switch (scope) {
    case RESOURCE_QUERY_SCOPE.ANONYMIZATION:
      return [
        workspaceAnonymizationTermsQueryRoot(workspaceId),
        workspaceAnonymizationAllowlistQueryRoot(workspaceId),
      ];
    case RESOURCE_QUERY_SCOPE.BILLING_CODES:
      return [billingCodesQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.CONTACTS:
      return [contactsQueryRoot(), workspaceContactsQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.ENTITIES:
      return [entitiesKeys.all(workspaceId)];
    case RESOURCE_QUERY_SCOPE.EXPENSES:
      return [expensesQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.FILES:
      return [filesQueryRoot()];
    case RESOURCE_QUERY_SCOPE.FLOW_RUNS:
      return [flowRunsQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.FLOW_STATE:
      return [
        workspaceWorkflowQueryRoot(workspaceId),
        workspaceJustificationsQueryRoot(workspaceId),
      ];
    case RESOURCE_QUERY_SCOPE.INVOICES:
      return [invoicesQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.JUSTIFICATIONS:
      return [workspaceJustificationsQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.LEGAL_LISTS:
      return [legalListsQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.MCP:
      return [mcpQueryRoot(), catalogueQueryRoot()];
    case RESOURCE_QUERY_SCOPE.ORGANIZATION:
      return [organizationQueryRoot(), organizationSettingsQueryRoot()];
    case RESOURCE_QUERY_SCOPE.PROPERTIES:
      return [propertiesQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.RATES:
      return [ratesQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.SKILLS:
      return [agentSkillsQueryRoot(), catalogueQueryRoot()];
    case RESOURCE_QUERY_SCOPE.TASKS:
      return [tasksQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.TIME_ENTRIES:
      return [timeEntriesQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.VIEWS:
      return [viewsRootKey(workspaceId)];
    case RESOURCE_QUERY_SCOPE.WORKSPACE_CONTACTS:
      return [workspaceContactsQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.WORKSPACE_MEMBERS:
      return [workspaceMembersQueryRoot(workspaceId)];
    case RESOURCE_QUERY_SCOPE.WORKSPACE_OVERVIEW:
      return [workspacesKeys.overview(workspaceId)];
    case RESOURCE_QUERY_SCOPE.WORKSPACES:
      return [workspacesKeys.all];
    default:
      scope satisfies never;
      return panic(`Unhandled scope: ${String(scope)}`);
  }
};

const getResourceTypeInvalidationActions = (
  resourceType: ResourceType,
  workspaceId: string,
): WorkspaceRealtimeQueryAction[] => {
  const actions: WorkspaceRealtimeQueryAction[] = [];
  for (const scope of RESOURCE_REALTIME_QUERY_POLICY[resourceType]) {
    for (const queryKey of getResourceQueryScopeKeys(scope, workspaceId)) {
      actions.push({
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey,
      });
    }
  }
  return actions;
};

const getResourceChangeQueryActions = (
  change: ResourceChange,
  workspaceId: string,
): WorkspaceRealtimeQueryAction[] => {
  const actions = getResourceTypeInvalidationActions(
    change.resource.type,
    workspaceId,
  );
  if (
    change.resource.type === RESOURCE_TYPE.ENTITY &&
    change.change === RESOURCE_CHANGE_TYPE.DELETED
  ) {
    actions.unshift({
      type: WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX,
      queryKey: entitiesKeys.detail(workspaceId, change.resource.id),
    });
  }

  if (change.resource.type !== RESOURCE_TYPE.FIELD) {
    return actions;
  }

  const fileActionType =
    change.change === RESOURCE_CHANGE_TYPE.DELETED
      ? WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX
      : WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE;
  const fieldKey = { workspaceId, fieldId: change.resource.id };
  actions.push(
    {
      type: fileActionType,
      queryKey: fileContentByFieldQueryRoot(fieldKey),
    },
    {
      type: fileActionType,
      queryKey: fileMetadataByFieldQueryRoot(fieldKey),
    },
  );
  return actions;
};

const getResourceSetUpdatedQueryActions = (
  resourceType: ResourceType,
  workspaceId: string,
): WorkspaceRealtimeQueryAction[] => {
  const actions = getResourceTypeInvalidationActions(resourceType, workspaceId);
  if (resourceType === RESOURCE_TYPE.FIELD) {
    actions.push({
      type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
      queryKey: filesQueryRoot(),
    });
  }
  return actions;
};

const deduplicateQueryActions = (
  actions: WorkspaceRealtimeQueryAction[],
): WorkspaceRealtimeQueryAction[] => {
  const seen = new Set<string>();
  const unique: WorkspaceRealtimeQueryAction[] = [];
  for (const action of actions) {
    const key = `${action.type}:${hashKey(action.queryKey)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(action);
  }
  return unique;
};

/**
 * Total cache policy for every workspace realtime event kind. Producers emit
 * domain facts; this web-only adapter owns their React Query consequences.
 */
export const getWorkspaceRealtimeQueryActions = (
  event: WorkspaceRealtimeEvent,
  workspaceId: string,
): WorkspaceRealtimeQueryAction[] => {
  switch (event.type) {
    case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
      return getResourceChangeQueryActions(
        {
          change: RESOURCE_CHANGE_TYPE.UPDATED,
          resource: event.resource,
        },
        workspaceId,
      );
    case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
      return getResourceChangeQueryActions(
        {
          change: RESOURCE_CHANGE_TYPE.DELETED,
          resource: event.resource,
        },
        workspaceId,
      );
    case REALTIME_EVENT_TYPE.RESOURCES_CHANGED: {
      const actions: WorkspaceRealtimeQueryAction[] = [];
      for (const change of event.changes) {
        for (const action of getResourceChangeQueryActions(
          change,
          workspaceId,
        )) {
          actions.push(action);
        }
      }
      return deduplicateQueryActions(actions);
    }
    case REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED:
      return getResourceSetUpdatedQueryActions(event.resourceType, workspaceId);
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
    case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
      return [];
    default:
      event satisfies never;
      return panic(`Unhandled event: ${String(event)}`);
  }
};

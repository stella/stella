import { hashKey, type QueryKey } from "@tanstack/react-query";

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
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { viewsRootKey } from "@/lib/workspaces/queries/views.logic";
import { workspaceKeys } from "@/lib/workspaces/queries/workspace";

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

const RESOURCE_QUERY_DISPOSITION = {
  NONE: "none",
  WORKSPACE_ENTITIES: "workspace_entities",
  WORKSPACE_FIELD: "workspace_field",
  WORKSPACE_FILES: "workspace_files",
  WORKSPACE_FLOW_STATE: "workspace_flow_state",
  WORKSPACE_VIEWS: "workspace_views",
} as const;

type ResourceQueryDisposition =
  (typeof RESOURCE_QUERY_DISPOSITION)[keyof typeof RESOURCE_QUERY_DISPOSITION];

/** Every resource type must explicitly choose its web-cache behavior. */
const RESOURCE_REALTIME_QUERY_POLICY = {
  [RESOURCE_TYPE.AGENT_SKILL]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.AGENT_SKILL_RESOURCE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.AI_MEMORY]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.BILLING_CODE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CASE_LAW_DECISION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CASE_LAW_SOURCE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CHAT_MESSAGE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CHAT_THREAD]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CLAUSE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CLAUSE_CATEGORY]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CLAUSE_VARIANT]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CLAUSE_VERSION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.CONTACT]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.DOCUMENT_TYPE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.ENTITY]: RESOURCE_QUERY_DISPOSITION.WORKSPACE_ENTITIES,
  [RESOURCE_TYPE.ENTITY_VERSION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.EXPENSE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.FIELD]: RESOURCE_QUERY_DISPOSITION.WORKSPACE_FIELD,
  [RESOURCE_TYPE.FLOW_DEFINITION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.FLOW_RUN]: RESOURCE_QUERY_DISPOSITION.WORKSPACE_FLOW_STATE,
  [RESOURCE_TYPE.INVOICE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.LEGAL_LIST]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.LEGISLATION_DOCUMENT]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.LEGISLATION_SOURCE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.MCP_CONNECTOR]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.ORGANIZATION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.PLAYBOOK]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.PROPERTY]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.RATE_ENTRY]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.RATE_TABLE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.REPORT_EXPORT]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.SAVED_SEARCH]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.STYLE_SET]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.TEMPLATE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.TEMPLATE_CATEGORY]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.TEMPLATE_VERSION]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.TIME_ENTRY]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.USER]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.USER_FILE]: RESOURCE_QUERY_DISPOSITION.WORKSPACE_FILES,
  [RESOURCE_TYPE.WORKSPACE]: RESOURCE_QUERY_DISPOSITION.NONE,
  [RESOURCE_TYPE.WORKSPACE_VIEW]: RESOURCE_QUERY_DISPOSITION.WORKSPACE_VIEWS,
  [RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE]: RESOURCE_QUERY_DISPOSITION.NONE,
} as const satisfies Record<ResourceType, ResourceQueryDisposition>;

const getResourceChangeQueryActions = (
  change: ResourceChange,
  workspaceId: string,
): WorkspaceRealtimeQueryAction[] => {
  const disposition = RESOURCE_REALTIME_QUERY_POLICY[change.resource.type];
  switch (disposition) {
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_ENTITIES: {
      const actions: WorkspaceRealtimeQueryAction[] = [];
      if (change.change === RESOURCE_CHANGE_TYPE.DELETED) {
        actions.push({
          type: WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX,
          queryKey: entitiesKeys.detail(workspaceId, change.resource.id),
        });
      }
      actions.push({
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey: entitiesKeys.all(workspaceId),
      });
      return actions;
    }
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_FIELD: {
      const fileActionType =
        change.change === RESOURCE_CHANGE_TYPE.DELETED
          ? WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX
          : WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE;
      const fieldKey = { workspaceId, fieldId: change.resource.id };
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: entitiesKeys.all(workspaceId),
        },
        {
          type: fileActionType,
          queryKey: fileContentByFieldQueryRoot(fieldKey),
        },
        {
          type: fileActionType,
          queryKey: fileMetadataByFieldQueryRoot(fieldKey),
        },
      ];
    }
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_FILES:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: filesQueryRoot(),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_FLOW_STATE:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: workspaceKeys.workflow(workspaceId),
        },
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: entitiesKeys.all(workspaceId),
        },
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: workspaceKeys.justifications(workspaceId),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_VIEWS:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: viewsRootKey(workspaceId),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.NONE:
      return [];
    default:
      return disposition satisfies never;
  }
};

const getResourceSetUpdatedQueryActions = (
  resourceType: ResourceType,
  workspaceId: string,
): WorkspaceRealtimeQueryAction[] => {
  const disposition = RESOURCE_REALTIME_QUERY_POLICY[resourceType];
  switch (disposition) {
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_ENTITIES:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: entitiesKeys.all(workspaceId),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_FIELD:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: entitiesKeys.all(workspaceId),
        },
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: filesQueryRoot(),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_FILES:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: filesQueryRoot(),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_FLOW_STATE:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: workspaceKeys.workflow(workspaceId),
        },
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: entitiesKeys.all(workspaceId),
        },
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: workspaceKeys.justifications(workspaceId),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.WORKSPACE_VIEWS:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: viewsRootKey(workspaceId),
        },
      ];
    case RESOURCE_QUERY_DISPOSITION.NONE:
      return [];
    default:
      return disposition satisfies never;
  }
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
    case REALTIME_EVENT_TYPE.INVALIDATE_QUERY:
      return [
        {
          type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
          queryKey: event.data,
        },
      ];
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
      return event satisfies never;
  }
};

import {
  hashKey,
  matchQuery,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { OrganizationCreator } from "better-auth/plugins";
import { panic, Result } from "better-result";

import {
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  RESOURCE_CHANGE_TYPE,
  RESOURCE_TYPE,
  type ResourceChange,
  type ResourceType,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
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
import {
  entitiesKeys,
  isEntityCollectionQueryKey,
} from "@/lib/workspaces/queries/entities.logic";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";
import { viewsRootKey } from "@/lib/workspaces/queries/views.logic";
import {
  workspaceJustificationsQueryRoot,
  workspaceWorkflowQueryRoot,
} from "@/lib/workspaces/queries/workspace.logic";

type ResourceQueryScopeIdentity =
  { type: "workspace"; workspaceId: string } | { type: "organization" };

type ResourceReads =
  | {
      resources: readonly [ResourceType, ...ResourceType[]];
      scope: ResourceQueryScopeIdentity;
    }
  | { type: "independent" };

type ResourceQueryMeta = Record<string, unknown> & {
  resourceReads?: ResourceReads;
};

type AuthPluginEndpointWrite<
  TEndpoint extends keyof ReturnType<OrganizationCreator>["endpoints"],
> = {
  type: "auth-plugin-endpoint";
  plugin: "organization";
  endpoint: TEndpoint;
  method: ReturnType<OrganizationCreator>["endpoints"][TEndpoint]["options"]["method"];
  route: ReturnType<OrganizationCreator>["endpoints"][TEndpoint]["path"];
};

declare module "@tanstack/react-query" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation requires an interface for declaration merging
  interface Register {
    queryMeta: ResourceQueryMeta;
  }
}

/** Declares resource dependencies or independence without changing cache identity. */
export const resourceQueryOptions = <
  TOptions extends { queryKey: QueryKey; meta?: ResourceQueryMeta },
  TReads extends ResourceReads,
>(
  options: TOptions,
  resourceReads: TReads,
) => ({
  ...options,
  meta: { ...options.meta, resourceReads },
});

export const RESOURCE_MUTATION_CONTRACTS = {
  createInvoice: {
    writes: [
      {
        type: "handler-route",
        method: "PUT",
        route: "/client-invoices/:clientId",
      },
      {
        type: "handler-route",
        method: "PUT",
        route: "/invoices/:workspaceId",
      },
      {
        type: "handler-route",
        method: "POST",
        route: "/invoices/:workspaceId/:invoiceId/transition",
      },
    ],
    resources: [RESOURCE_TYPE.INVOICE],
  },
  transitionInvoice: {
    writes: [
      {
        type: "handler-route",
        method: "POST",
        route: "/invoices/:workspaceId/:invoiceId/transition",
      },
    ],
    resources: [RESOURCE_TYPE.INVOICE],
  },
  renameEntity: {
    writes: [
      {
        type: "handler-route",
        method: "PATCH",
        route: "/entities/:workspaceId/rename",
      },
    ],
    resources: [RESOURCE_TYPE.ENTITY],
    // One entity changes, named by this variable: its own queries and every
    // entity collection refresh, never the other cached entity details.
    changedEntity: "entityId",
  },
  installCatalogueEntry: {
    writes: [
      {
        type: "handler-route",
        method: "POST",
        route: "/catalogue/install-skill",
      },
      { type: "handler-route", method: "POST", route: "/mcp/connectors" },
      {
        type: "handler-route",
        method: "PATCH",
        route: "/mcp/native-tools/:slug",
      },
    ],
    resources: [RESOURCE_TYPE.AGENT_SKILL, RESOURCE_TYPE.MCP_CONNECTOR],
  },
  uninstallCatalogueEntry: {
    writes: [
      {
        type: "handler-route",
        method: "DELETE",
        route: "/mcp/connectors/:slug",
      },
      {
        type: "handler-route",
        method: "PATCH",
        route: "/mcp/native-tools/:slug",
      },
      { type: "handler-route", method: "DELETE", route: "/skills/:skillId" },
    ],
    resources: [
      RESOURCE_TYPE.AGENT_SKILL,
      RESOURCE_TYPE.AGENT_SKILL_COMMENT,
      RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
      RESOURCE_TYPE.AGENT_SKILL_RESOURCE,
      RESOURCE_TYPE.AGENT_SKILL_REVISION,
      RESOURCE_TYPE.MCP_CONNECTOR,
    ],
  },
  updateNativeTool: {
    writes: [
      {
        type: "handler-route",
        method: "PATCH",
        route: "/mcp/native-tools/:slug",
      },
    ],
    resources: [RESOURCE_TYPE.MCP_CONNECTOR],
  },
  addMcpServer: {
    writes: [
      { type: "handler-route", method: "POST", route: "/mcp/connectors" },
    ],
    resources: [RESOURCE_TYPE.MCP_CONNECTOR],
  },
  connectMcpServer: {
    writes: [
      {
        type: "handler-route",
        method: "POST",
        route: "/mcp/connectors/:slug/connect",
      },
    ],
    resources: [RESOURCE_TYPE.MCP_CONNECTOR],
  },
  saveMcpToken: {
    writes: [
      { type: "handler-route", method: "POST", route: "/mcp/connections" },
    ],
    resources: [RESOURCE_TYPE.MCP_CONNECTOR],
  },
  deleteOrganization: {
    writes: [
      {
        type: "auth-plugin-endpoint",
        plugin: "organization",
        endpoint: "deleteOrganization",
        method: "POST",
        route: "/organization/delete",
      } satisfies AuthPluginEndpointWrite<"deleteOrganization">,
      {
        type: "auth-plugin-endpoint",
        plugin: "organization",
        endpoint: "leaveOrganization",
        method: "POST",
        route: "/organization/leave",
      } satisfies AuthPluginEndpointWrite<"leaveOrganization">,
    ],
    resources: [RESOURCE_TYPE.ORGANIZATION],
  },
} as const;

type ResourceMutationName = keyof typeof RESOURCE_MUTATION_CONTRACTS;

/** The variable naming the one entity a contract changes, if it names one. */
type ChangedEntityVariable<TMutation extends ResourceMutationName> =
  (typeof RESOURCE_MUTATION_CONTRACTS)[TMutation] extends {
    changedEntity: infer TName extends string;
  }
    ? TName
    : never;

type OrganizationResourceMutationName = {
  [TMutation in ResourceMutationName]: [
    ChangedEntityVariable<TMutation>,
  ] extends [never]
    ? TMutation
    : never;
}[ResourceMutationName];

type ResourceMutationOptions<
  TMutation extends ResourceMutationName,
  TVariables,
  TData,
> = {
  mutation: TMutation;
  queryClient: QueryClient;
  mutationFn: (variables: TVariables) => Promise<TData>;
};

type ResourceMutationScope =
  | { type: "organization" }
  | { type: "workspace"; workspaceId: string; changedEntityId?: string };

const invalidateAfterResourceMutation = async ({
  mutation,
  queryClient,
  scope,
}: {
  mutation: ResourceMutationName;
  queryClient: QueryClient;
  scope: ResourceMutationScope;
}) => {
  const resources = RESOURCE_MUTATION_CONTRACTS[mutation].resources;
  const invalidations: ResourceQueryInvalidation[] =
    registeredResourceQueryActions({ queryClient, resources, scope }).map(
      ({ queryKey }): ResourceQueryInvalidation => ({
        queryKey,
        match: "prefix",
      }),
    );
  if (scope.type === "workspace") {
    for (const resource of resources) {
      for (const policyScope of RESOURCE_REALTIME_QUERY_POLICY[resource]) {
        invalidations.push(
          ...(policyScope === RESOURCE_QUERY_SCOPE.ENTITIES &&
          scope.changedEntityId !== undefined
            ? getChangedEntityInvalidations(
                scope.workspaceId,
                scope.changedEntityId,
              )
            : getResourceQueryScopeKeys(policyScope, scope.workspaceId).map(
                (queryKey): ResourceQueryInvalidation => ({
                  queryKey,
                  match: "prefix",
                }),
              )),
        );
      }
    }
  }
  await invalidateResourceQueries(
    queryClient,
    deduplicateInvalidations(invalidations),
  );
};

const stringVariable = (variables: unknown, name: string): string => {
  const value: unknown =
    typeof variables === "object" && variables !== null
      ? Reflect.get(variables, name)
      : undefined;
  return typeof value === "string"
    ? value
    : panic(`A workspace-scoped resource mutation needs a ${name}`);
};

const workspaceMutationScope = (
  mutation: ResourceMutationName,
  variables: unknown,
): ResourceMutationScope => {
  const contract: { changedEntity?: string } =
    RESOURCE_MUTATION_CONTRACTS[mutation];
  const workspaceId = stringVariable(variables, "workspaceId");
  return contract.changedEntity === undefined
    ? { type: "workspace", workspaceId }
    : {
        type: "workspace",
        workspaceId,
        changedEntityId: stringVariable(variables, contract.changedEntity),
      };
};

/**
 * A committed write marks every registered reader stale before it settles.
 * Workspace writes carry their workspace in the variables; organization
 * writes declare `scope: { type: "organization" }` and need none. A contract
 * naming a `changedEntity` variable refreshes only that entity's queries and
 * the entity collections, never every cached entity detail.
 */
export function resourceMutation<
  TMutation extends ResourceMutationName,
  TVariables extends { workspaceId: string } & Record<
    ChangedEntityVariable<TMutation>,
    string
  >,
  TData,
>(
  options: ResourceMutationOptions<TMutation, TVariables, TData> & {
    scope?: { type: "workspace" };
  },
): (variables: TVariables) => Promise<TData>;
export function resourceMutation<
  TMutation extends OrganizationResourceMutationName,
  TVariables,
  TData,
>(
  options: ResourceMutationOptions<TMutation, TVariables, TData> & {
    scope: { type: "organization" };
  },
): (variables: TVariables) => Promise<TData>;
export function resourceMutation<TVariables, TData>({
  mutation,
  queryClient,
  mutationFn,
  scope,
}: ResourceMutationOptions<ResourceMutationName, TVariables, TData> & {
  scope?: { type: "workspace" } | { type: "organization" };
}): (variables: TVariables) => Promise<TData> {
  return async (variables: TVariables) => {
    const data = await mutationFn(variables);
    await invalidateAfterResourceMutation({
      mutation,
      queryClient,
      scope:
        scope?.type === "organization"
          ? scope
          : workspaceMutationScope(mutation, variables),
    });
    return data;
  };
}

export const parseWorkspaceRealtimeMessage = (
  data: string,
): WorkspaceRealtimeEvent | null => {
  try {
    return parseWorkspaceRealtimeEvent(JSON.parse(data));
  } catch {
    return null;
  }
};

const keyPartMentions = (part: unknown, workspaceId: string): boolean => {
  if (part === workspaceId) {
    return true;
  }
  if (Array.isArray(part)) {
    return part.some((item) => keyPartMentions(item, workspaceId));
  }
  if (typeof part === "object" && part !== null) {
    return Object.values(part).some((value) =>
      keyPartMentions(value, workspaceId),
    );
  }
  return false;
};

/**
 * Whether a cached query holds data from one matter. Query key factories
 * place the matter id at different depths (a path segment, a field of a key
 * object), and matter ids are UUIDs, so any key naming the id anywhere is
 * that matter's data.
 */
export const isWorkspaceQueryKey = (
  queryKey: QueryKey,
  workspaceId: string,
): boolean => keyPartMentions(queryKey, workspaceId);

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
  CATALOGUE: "catalogue",
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
  MY_WORK: "my_work",
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
  [RESOURCE_TYPE.AGENT_SKILL]: [
    RESOURCE_QUERY_SCOPE.CATALOGUE,
    RESOURCE_QUERY_SCOPE.SKILLS,
  ],
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
    RESOURCE_QUERY_SCOPE.MY_WORK,
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
  [RESOURCE_TYPE.MCP_CONNECTOR]: [
    RESOURCE_QUERY_SCOPE.CATALOGUE,
    RESOURCE_QUERY_SCOPE.MCP,
  ],
  [RESOURCE_TYPE.NUMBER_SERIES]: [RESOURCE_QUERY_SCOPE.ORGANIZATION],
  [RESOURCE_TYPE.VAT_RATE]: [RESOURCE_QUERY_SCOPE.ORGANIZATION],
  [RESOURCE_TYPE.ORGANIZATION]: [RESOURCE_QUERY_SCOPE.ORGANIZATION],
  [RESOURCE_TYPE.PLAYBOOK]: [],
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: [],
  [RESOURCE_TYPE.PROPERTY]: [RESOURCE_QUERY_SCOPE.PROPERTIES],
  [RESOURCE_TYPE.RATE_ENTRY]: [RESOURCE_QUERY_SCOPE.RATES],
  [RESOURCE_TYPE.RATE_TABLE]: [RESOURCE_QUERY_SCOPE.RATES],
  [RESOURCE_TYPE.REPORT_EXPORT]: [],
  [RESOURCE_TYPE.SAVED_SEARCH]: [],
  [RESOURCE_TYPE.SELLER_PROFILE]: [],
  // Personal organization-level lists invalidate through their own mutations.
  [RESOURCE_TYPE.SAVED_TIME_NARRATIVE]: [],
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
    case RESOURCE_QUERY_SCOPE.CATALOGUE:
      return [catalogueQueryRoot()];
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
    case RESOURCE_QUERY_SCOPE.MY_WORK:
      return [myWorkKeys.all];
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

/**
 * A local write's cache invalidation. `prefix` marks every query under the
 * key; `entity-collections` marks only the queries under the entity root that
 * span many entities, never one entity's own queries.
 */
type ResourceQueryInvalidation = {
  queryKey: QueryKey;
  match: "prefix" | "entity-collections";
};

/**
 * One known entity changed: its own queries and every entity collection
 * refresh, never the other entities' details under the shared entity root.
 */
const getChangedEntityInvalidations = (
  workspaceId: string,
  entityId: string,
): ResourceQueryInvalidation[] => [
  { queryKey: entitiesKeys.all(workspaceId), match: "entity-collections" },
  { queryKey: entitiesKeys.detail(workspaceId, entityId), match: "prefix" },
];

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

type RegisteredResourceQueryActionsOptions = {
  queryClient: QueryClient;
  resources: readonly ResourceType[];
  scope: ResourceQueryScopeIdentity;
};

const registeredResourceQueryActions = ({
  queryClient,
  resources,
  scope,
}: RegisteredResourceQueryActionsOptions): WorkspaceRealtimeQueryAction[] =>
  queryClient
    .getQueryCache()
    .findAll({
      predicate: ({ meta }) => {
        const reads = meta?.resourceReads;
        if (
          !reads ||
          "type" in reads ||
          !reads.resources.some((resource) => resources.includes(resource))
        ) {
          return false;
        }
        return (
          (scope.type === "organization" &&
            reads.scope.type === "organization") ||
          (scope.type === "workspace" &&
            (reads.scope.type === "organization" ||
              scope.workspaceId === reads.scope.workspaceId))
        );
      },
    })
    .map(({ queryKey }) => ({
      type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
      queryKey,
    }));

const deduplicateInvalidations = (
  invalidations: readonly ResourceQueryInvalidation[],
): ResourceQueryInvalidation[] => {
  const seen = new Set<string>();
  const unique: ResourceQueryInvalidation[] = [];
  for (const invalidation of invalidations) {
    const key = `${invalidation.match}:${hashKey(invalidation.queryKey)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(invalidation);
  }
  return unique;
};

/** Whether a query under an invalidation's key is one it marks stale. */
const invalidationReaches = (
  match: ResourceQueryInvalidation["match"],
  queryKey: QueryKey,
): boolean => {
  switch (match) {
    case "prefix":
      return true;
    case "entity-collections":
      return isEntityCollectionQueryKey(queryKey);
    default:
      match satisfies never;
      return panic(`Unhandled invalidation match: ${String(match)}`);
  }
};

/**
 * Marks a committed local write's readers stale, then refreshes the active
 * ones without making the write wait on, or fail with, the refetch.
 */
const invalidateResourceQueries = async (
  queryClient: QueryClient,
  invalidations: readonly ResourceQueryInvalidation[],
) => {
  const invalidated = await Result.tryPromise(
    async () =>
      await Promise.all(
        invalidations.map(async ({ queryKey, match }) => {
          await queryClient.invalidateQueries({
            queryKey,
            predicate: (query) => invalidationReaches(match, query.queryKey),
            refetchType: "none",
          });
        }),
      ),
  );
  if (Result.isError(invalidated)) {
    getAnalytics().captureError(invalidated.error, {
      fingerprintKey: "detached:resource-query.invalidate",
      scope: {
        type: "handler",
        handlerId: "detached:resource-query.invalidate",
      },
      context: { type: "detached", operation: "resource-query.invalidate" },
    });
  }
  // Refetch failure must not turn a committed write into a rejected mutation.
  detached(
    queryClient.refetchQueries({
      type: "active",
      predicate: (query) =>
        invalidations.some(
          ({ queryKey, match }) =>
            matchQuery({ queryKey }, query) &&
            invalidationReaches(match, query.queryKey),
        ),
    }),
    "resource-query.refresh",
  );
};

/**
 * What to refresh after the workspace stream reconnects: every scope any
 * event could invalidate, since the events missed while disconnected are not
 * replayed. Derived from the scope list itself, so a scope added for a new
 * event is refreshed on reconnect without a second list to update.
 */
type WorkspaceQueryActionsScope = {
  workspaceId: string;
  queryClient: QueryClient;
};

export const getWorkspaceReconnectQueryActions = ({
  workspaceId,
  queryClient,
}: WorkspaceQueryActionsScope): WorkspaceRealtimeQueryAction[] => {
  const actions: WorkspaceRealtimeQueryAction[] = [];
  for (const scope of Object.values(RESOURCE_QUERY_SCOPE)) {
    for (const queryKey of getResourceQueryScopeKeys(scope, workspaceId)) {
      actions.push({
        type: WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE,
        queryKey,
      });
    }
  }
  actions.push(
    ...registeredResourceQueryActions({
      queryClient,
      resources: Object.values(RESOURCE_TYPE),
      scope: { type: "workspace", workspaceId },
    }),
  );
  return deduplicateQueryActions(actions);
};

/**
 * Total cache policy for every workspace realtime event kind. Producers emit
 * domain facts; this web-only adapter owns their React Query consequences.
 */
const getResourceEventQueryActions = (
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

export const getWorkspaceRealtimeQueryActions = (
  event: WorkspaceRealtimeEvent,
  { workspaceId, queryClient }: WorkspaceQueryActionsScope,
): WorkspaceRealtimeQueryAction[] => {
  const actions = getResourceEventQueryActions(event, workspaceId);
  const resources: ResourceType[] = [];
  switch (event.type) {
    case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
    case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
      resources.push(event.resource.type);
      break;
    case REALTIME_EVENT_TYPE.RESOURCES_CHANGED:
      resources.push(...event.changes.map(({ resource }) => resource.type));
      break;
    case REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED:
      resources.push(event.resourceType);
      break;
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
    case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
      break;
    default:
      event satisfies never;
      return panic(`Unhandled event: ${String(event)}`);
  }
  return deduplicateQueryActions([
    ...actions,
    ...registeredResourceQueryActions({
      queryClient,
      resources,
      scope: { type: "workspace", workspaceId },
    }),
  ]);
};

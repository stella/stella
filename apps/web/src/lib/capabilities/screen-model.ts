import { useLocation, useMatches } from "@tanstack/react-router";

import {
  parseResourceRef,
  RESOURCE_TYPE,
  toResourceName,
} from "@stll/api-contract";
import type { ResourceName, ResourceType } from "@stll/api-contract";

import { useScreenActionsStore } from "@/lib/capabilities/screen-actions";
import type { ScreenAction } from "@/lib/capabilities/screen-actions";
import type { FileRoutesById } from "@/routeTree.gen";

/**
 * What a route parameter names. Every `$param` in the route tree has an entry
 * (a test compares this map with the generated tree), so a new parameter
 * cannot reach the screen model without a decision.
 */
type RouteParamDisposition =
  | { type: "resource"; resourceType: ResourceType }
  | { type: "not-a-resource"; reason: string };

const resourceParam = (resourceType: ResourceType) =>
  ({ type: "resource", resourceType }) as const;
const notAResource = (reason: string) =>
  ({ type: "not-a-resource", reason }) as const;

export const ROUTE_PARAM_DISPOSITIONS = {
  workspaceId: resourceParam(RESOURCE_TYPE.WORKSPACE),
  viewId: resourceParam(RESOURCE_TYPE.WORKSPACE_VIEW),
  threadId: resourceParam(RESOURCE_TYPE.CHAT_THREAD),
  contactId: resourceParam(RESOURCE_TYPE.CONTACT),
  invoiceId: resourceParam(RESOURCE_TYPE.INVOICE),
  exportId: resourceParam(RESOURCE_TYPE.REPORT_EXPORT),
  correspondenceId: notAResource("correspondence has no resource type"),
  templateId: notAResource(
    "a bundled catalogue template, not an organization template",
  ),
  packId: notAResource("a bundled catalogue pack"),
  invitationId: notAResource("an authentication invitation"),
  registry: notAResource("an external business registry"),
  companyId: notAResource("a company in an external business registry"),
  entry: notAResource("a public tools catalogue entry"),
  slug: notAResource("a public address, not an identifier"),
  country: notAResource("a jurisdiction code"),
  court: notAResource("a court code"),
  language: notAResource("a language code"),
  version: notAResource("a statute version date"),
  year: notAResource("a sitemap partition"),
  month: notAResource("a sitemap partition"),
  bucket: notAResource("a sitemap partition"),
  code: notAResource("a verification code"),
  tableId: notAResource("a case-law research table"),
} as const satisfies Record<string, RouteParamDisposition>;

// Routes whose search parameters say which resource has focus. `Extract`
// against the generated route ids turns a renamed route into a type error.
type FocusRouteId = Extract<
  keyof FileRoutesById,
  "/_protected/workspaces/$workspaceId/$viewId/document"
>;

const FOCUS_SEARCH_PARAMS = {
  "/_protected/workspaces/$workspaceId/$viewId/document": {
    field: RESOURCE_TYPE.FIELD,
    entity: RESOURCE_TYPE.ENTITY,
  },
} as const satisfies Record<FocusRouteId, Record<string, ResourceType>>;

type ScreenModel = {
  route: { id: string; pathname: string };
  /** Resources the screen shows: route resources, focus and action targets. */
  resources: readonly ResourceName[];
  /** The resource the user is working in, when the route tracks one. */
  focus: ResourceName | null;
  /** Capabilities mounted controls offer, one entry per action and resource. */
  actions: readonly ScreenAction[];
};

type DeriveScreenModelOptions = {
  routeId: string;
  pathname: string;
  params: Readonly<Record<string, unknown>>;
  search: Readonly<Record<string, unknown>>;
  actions: Iterable<ScreenAction>;
};

const resourceName = (type: ResourceType, id: unknown): ResourceName | null => {
  const ref = parseResourceRef({ type, id });
  return ref === null ? null : toResourceName(ref);
};

const isRouteParam = (
  name: string,
): name is keyof typeof ROUTE_PARAM_DISPOSITIONS =>
  Object.hasOwn(ROUTE_PARAM_DISPOSITIONS, name);

const isFocusRoute = (
  routeId: string,
): routeId is keyof typeof FOCUS_SEARCH_PARAMS =>
  Object.hasOwn(FOCUS_SEARCH_PARAMS, routeId);

const routeResources = (
  params: Readonly<Record<string, unknown>>,
): ResourceName[] => {
  const names: ResourceName[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (!isRouteParam(name)) {
      continue;
    }
    const disposition = ROUTE_PARAM_DISPOSITIONS[name];
    if (disposition.type === "not-a-resource") {
      continue;
    }
    const resource = resourceName(disposition.resourceType, value);
    if (resource !== null) {
      names.push(resource);
    }
  }
  return names;
};

// The most specific focus wins: a field inside the open document over the
// document itself, as listed first in the route's entry.
const focusResource = (
  routeId: string,
  search: Readonly<Record<string, unknown>>,
): ResourceName | null => {
  if (!isFocusRoute(routeId)) {
    return null;
  }
  for (const [key, type] of Object.entries(FOCUS_SEARCH_PARAMS[routeId])) {
    const resource = resourceName(type, search[key]);
    if (resource !== null) {
      return resource;
    }
  }
  return null;
};

const uniqueActions = (actions: Iterable<ScreenAction>): ScreenAction[] => {
  const seen = new Set<string>();
  const unique: ScreenAction[] = [];
  for (const action of actions) {
    const key = `${action.capability} ${action.resource}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(action);
    }
  }
  return unique;
};

/** The screen model for one route state and the actions mounted on it. */
export const deriveScreenModel = ({
  routeId,
  pathname,
  params,
  search,
  actions,
}: DeriveScreenModelOptions): ScreenModel => {
  const focus = focusResource(routeId, search);
  const offered = uniqueActions(actions);
  const resources = new Set<ResourceName>(routeResources(params));
  if (focus !== null) {
    resources.add(focus);
  }
  for (const action of offered) {
    resources.add(action.resource);
  }
  return {
    route: { id: routeId, pathname },
    resources: [...resources],
    focus,
    actions: offered,
  };
};

/** The live screen model of the current route. */
export const useScreenModel = (): ScreenModel => {
  const match = useMatches({ select: (matches) => matches.at(-1) });
  const location = useLocation();
  const actions = useScreenActionsStore((state) => state.actions);
  return deriveScreenModel({
    routeId: match?.routeId ?? "",
    pathname: location.pathname,
    params: match?.params ?? {},
    search: location.search,
    actions: actions.values(),
  });
};

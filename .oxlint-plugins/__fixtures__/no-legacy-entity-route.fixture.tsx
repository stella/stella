// Passive regression fixture for `no-legacy-entity-route/no-legacy-entity-route`.
// Disabled lines must be reported; unrelated non-public paths must leave no
// diagnostics.

declare const workspaceId: string;
declare const entityId: string;
declare const panel: string;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRoute = "/workspaces/$workspaceId/entities/$entityId";

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const staticTemplateLegacyRoute = `/workspaces/$workspaceId/entities/$entityId`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const constructedLegacyRoute = `/workspaces/${workspaceId}/entities/${entityId}`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRouteWithQuery = `/workspaces/${workspaceId}/entities/${entityId}?panel=versions`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRouteWithFragment = `/workspaces/${workspaceId}/entities/${entityId}#versions`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRouteWithTrailingSlash = `/workspaces/${workspaceId}/entities/${entityId}/`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRouteDescendant = `/workspaces/${workspaceId}/entities/${entityId}/versions`;

export const staticLegacyRouteWithQuery =
  // oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
  "/workspaces/$workspaceId/entities/$entityId?panel=versions";

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const hardcodedLegacyRoute = "/workspaces/ws_123/entities/entity_456";

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRouteWithDynamicQuery = `/workspaces/${workspaceId}/entities/${entityId}?panel=${panel}`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const oneDynamicWorkspace = `/workspaces/${workspaceId}/entities/entity_456`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const oneDynamicEntity = `/workspaces/ws_123/entities/${entityId}`;

export const concatenatedLegacyRoute =
  // oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route, prefer-template -- regression case
  "/workspaces/" + workspaceId + "/entities/" + entityId;

export const currentDocumentRoute = "/workspaces/$workspaceId/$viewId/document";
export const similarlyStructuredPrivatePath =
  "/_protected/workspaces/$workspaceId/entities/$entityId";
export const entityApiRoute = `/entities/${workspaceId}/entity/${entityId}`;
export const similarlyNamedRoute = `/workspaces/${workspaceId}/entity-versions/${entityId}`;
export const similarlySuffixedRoute = `/workspaces/${workspaceId}/entities/${entityId}-archive`;
export const similarlySuffixedConcatenation =
  // oxlint-disable-next-line prefer-template -- intentional near-match for the concatenation guard
  "/workspaces/" + workspaceId + "/entities/" + entityId + "-archive";

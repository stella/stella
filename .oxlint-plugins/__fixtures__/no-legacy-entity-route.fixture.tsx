// Passive regression fixture for `no-legacy-entity-route/no-legacy-entity-route`.
// Disabled lines must be reported; unrelated non-public paths must leave no
// diagnostics.

declare const workspaceId: string;
declare const entityId: string;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const legacyRoute = "/workspaces/$workspaceId/entities/$entityId";

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const staticTemplateLegacyRoute = `/workspaces/$workspaceId/entities/$entityId`;

// oxlint-disable-next-line no-legacy-entity-route/no-legacy-entity-route -- regression case
export const constructedLegacyRoute = `/workspaces/${workspaceId}/entities/${entityId}`;

export const currentDocumentRoute =
  "/workspaces/$workspaceId/$viewId/document";
export const similarlyStructuredPrivatePath =
  "/_protected/workspaces/$workspaceId/entities/$entityId";
export const entityApiRoute = `/entities/${workspaceId}/entity/${entityId}`;
export const similarlyNamedRoute = `/workspaces/${workspaceId}/entities/${entityId}/versions`;

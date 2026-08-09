// Passive regression fixture for
// `no-body-ownership-ids/no-body-ownership-ids`.

declare const body: { title: string; workspaceId: string };
declare const ctx: { session: { activeOrganizationId: string } };
declare const query: { organizationId: string; search: string };

// MUST flag: ownership cannot come directly from the request body.
// oxlint-disable-next-line no-body-ownership-ids/no-body-ownership-ids -- fixture: body workspace ownership must be rejected
export const bodyWorkspaceId = body.workspaceId;

// MUST flag: query-derived organization ownership is equally unsafe.
// oxlint-disable-next-line no-body-ownership-ids/no-body-ownership-ids -- fixture: query organization ownership must be rejected
export const queryOrganizationId = query.organizationId;

// MUST flag: destructuring cannot hide the untrusted ownership source.
// oxlint-disable-next-line no-body-ownership-ids/no-body-ownership-ids -- fixture: destructured body ownership must be rejected
export const { workspaceId: destructuredWorkspaceId } = body;

// Allowed: non-ownership request fields remain ordinary input.
export const requestTitle = body.title;
export const requestSearch = query.search;

// Allowed: organization ownership comes from authenticated server context.
export const activeOrganizationId = ctx.session.activeOrganizationId;

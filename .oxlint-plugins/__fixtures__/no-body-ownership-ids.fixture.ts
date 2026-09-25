// Passive regression fixture for
// `no-body-ownership-ids/no-body-ownership-ids`.

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";

declare const body: { title: string; workspaceId: string };
declare const ctx: { session: { activeOrganizationId: string } };
declare const query: { organizationId: string; search: string };
declare const getWorkspaceAccess: Parameters<
  typeof resolveChatScope
>[0]["getWorkspaceAccess"];
declare const store: { find: (options: { workspaceId: string }) => unknown };
declare const otherResolver: (options: { workspaceId: string }) => unknown;

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
// expect-clean: no-body-ownership-ids/no-body-ownership-ids
export const requestTitle = body.title;
export const requestSearch = query.search;

// Allowed: organization ownership comes from authenticated server context.
export const activeOrganizationId = ctx.session.activeOrganizationId;

// Allowed: the requested id goes straight to the resolver that authorizes it.
// expect-clean: no-body-ownership-ids/no-body-ownership-ids
export const resolvedScope = resolveChatScope({
  getWorkspaceAccess,
  workspaceId: body.workspaceId,
});

// MUST flag: the same id used directly, next to the sanctioned call.
// oxlint-disable-next-line no-body-ownership-ids/no-body-ownership-ids -- fixture: a direct use of the requested id is still rejected
export const directLookup = store.find({ workspaceId: body.workspaceId });

// MUST flag: only the imported resolver is a sink, not any call of that shape.
// oxlint-disable-next-line no-body-ownership-ids/no-body-ownership-ids -- fixture: a look-alike resolver is not a sink
export const lookAlike = otherResolver({ workspaceId: body.workspaceId });

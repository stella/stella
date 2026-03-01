import * as v from "valibot";

import type { FileRoutesByFullPath, FileRouteTypes } from "@/routeTree.gen";

export type AcceptInvitationPath = Extract<
  keyof FileRoutesByFullPath,
  `/auth/accept-invitation/${string}`
>;

const ACCEPT_INVITATION_ROUTE_PREFIX: AcceptInvitationPath extends `${infer P}$invitationId`
  ? `${P}`
  : never = "/auth/accept-invitation/";

export const isAcceptInvitationRedirect = (path: string) =>
  path.startsWith(ACCEPT_INVITATION_ROUTE_PREFIX);

const isSafeRedirectPath = (s: string) =>
  s.startsWith("/") && !s.startsWith("//");

const WORKSPACES_ROUTE: FileRouteTypes["to"] = "/workspaces";

/**
 * Valibot schema for redirectTo search param.
 * Validates that the URL is safe (prevents open-redirect attacks) and defaults to /workspaces.
 * Only allows relative paths starting with "/" but not "//".
 */
export const redirectToSchema = v.pipe(
  v.optional(v.string(), WORKSPACES_ROUTE),
  v.transform((s) => (isSafeRedirectPath(s) ? s : WORKSPACES_ROUTE)),
);

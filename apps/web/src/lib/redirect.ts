import * as v from "valibot";

import type { FileRoutesByFullPath, FileRouteTypes } from "@/routeTree.gen";

type AcceptInvitationPath = Extract<
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

const DEFAULT_REDIRECT: FileRouteTypes["to"] = "/";

/**
 * Valibot schema for redirectTo search param.
 * Validates that the URL is safe (prevents open-redirect attacks)
 * and defaults to "/" (which resolves last-active workspace).
 * Only allows relative paths starting with "/" but not "//".
 */
export const redirectToSchema = v.pipe(
  v.optional(v.string(), DEFAULT_REDIRECT),
  v.transform((s) => (isSafeRedirectPath(s) ? s : DEFAULT_REDIRECT)),
);

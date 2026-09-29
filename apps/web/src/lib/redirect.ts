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

// A redirect target is safe only when it is a relative path whose second
// character is neither "/" nor "\": browsers normalize both "//host" and
// "/\host" (and "\/host") to a protocol-relative external origin, so the
// "//"-only check is insufficient to prevent open redirects. URL parsers also
// drop tabs and newlines ("/\t/host" reads as "//host"), so control characters
// are refused outright, and the result must still resolve to this origin.
const REDIRECT_BASE = "https://redirect.invalid";

const isSafeRedirectPath = (s: string) =>
  /^\/(?![/\\])/u.test(s) &&
  !/\p{Cc}/u.test(s) &&
  URL.canParse(s, REDIRECT_BASE) &&
  new URL(s, REDIRECT_BASE).origin === REDIRECT_BASE;

const DEFAULT_REDIRECT: FileRouteTypes["to"] = "/";

export const normalizeRedirectTo = (value: string): string =>
  isSafeRedirectPath(value) ? value : DEFAULT_REDIRECT;

/**
 * The page a signed-out visitor asked for, as a `redirectTo` value: its path
 * and query, so filters and intents survive the trip through sign-in.
 */
export const returnPathOf = (location: {
  pathname: string;
  searchStr: string;
}): string => normalizeRedirectTo(location.pathname + location.searchStr);

// Sign-in and onboarding pages are steps of the trip, never its end.
const AUTH_FLOW_PATH = /^\/(?:auth|onboarding)(?:[/?#]|$)/u;

/**
 * Where the sign-up flow may land once the account and organization exist:
 * a safe path outside the auth and onboarding pages, or `undefined` so the
 * caller picks its own landing page. The default "/" names no page of its own,
 * so it is `undefined` too.
 */
export const toAppRedirectTo = (
  value: string | undefined,
): string | undefined =>
  value !== undefined &&
  value !== DEFAULT_REDIRECT &&
  isSafeRedirectPath(value) &&
  !AUTH_FLOW_PATH.test(value)
    ? value
    : undefined;

/**
 * Valibot schema for redirectTo search param.
 * Validates that the URL is safe (prevents open-redirect attacks)
 * and defaults to "/" (which resolves last-active workspace).
 * Only allows relative paths starting with "/" but not "//".
 */
export const redirectToSchema = v.pipe(
  v.optional(v.string(), DEFAULT_REDIRECT),
  v.transform(normalizeRedirectTo),
);

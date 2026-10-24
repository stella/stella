import type { NavigateOptions, RegisteredRouter } from "@tanstack/react-router";
import { Result } from "better-result";
import * as v from "valibot";

import { canonicalRedirectPath } from "@stll/api-contract/redirect-path";

import type { FileRoutesByFullPath, FileRouteTypes } from "@/routeTree.gen";

type NavigateTo<TTo extends FileRouteTypes["to"]> = NavigateOptions<
  RegisteredRouter,
  string,
  TTo
>;

type AcceptInvitationPath = Extract<
  keyof FileRoutesByFullPath,
  `/auth/accept-invitation/${string}`
>;

const ACCEPT_INVITATION_ROUTE_PREFIX: AcceptInvitationPath extends `${infer P}$invitationId`
  ? `${P}`
  : never = "/auth/accept-invitation/";

export const isAcceptInvitationRedirect = (path: string) =>
  path.startsWith(ACCEPT_INVITATION_ROUTE_PREFIX);

const REDIRECT_BASE = "https://redirect.invalid";

const DEFAULT_REDIRECT: FileRouteTypes["to"] = "/";

/** The resolved target, or "/" when it is not a safe same-origin path. */
export const normalizeRedirectTo = (value: string): string =>
  canonicalRedirectPath(value) ?? DEFAULT_REDIRECT;

/**
 * The page a signed-out visitor asked for, as a `redirectTo` value: its path
 * and query, so filters and intents survive the trip through sign-in.
 */
export const returnPathOf = (location: {
  pathname: string;
  searchStr: string;
}): string => normalizeRedirectTo(location.pathname + location.searchStr);

// Sign-in and onboarding pages are steps of the trip, never its end. Route
// matching ignores case and decodes the path, so the check does too.
const AUTH_FLOW_PATH = /^\/(?:auth|onboarding)(?:\/|$)/iu;

/** Whether a page is a sign-in or onboarding step. */
export const isAuthFlowPathname = (pathname: string): boolean =>
  AUTH_FLOW_PATH.test(pathname);

// A malformed escape cannot name a page, so it is no destination either.
const decodedPathname = (path: string): string | undefined =>
  Result.try(() =>
    decodeURIComponent(new URL(path, REDIRECT_BASE).pathname),
  ).unwrapOr(undefined);

/**
 * Where the sign-up flow may land once the account and organization exist:
 * the resolved safe path outside the auth and onboarding pages, or
 * `undefined` so the caller picks its own landing page. The default "/" names
 * no page of its own, so it is `undefined` too.
 */
export const toAppRedirectTo = (
  value: string | undefined,
): string | undefined => {
  const canonical =
    value === undefined ? undefined : canonicalRedirectPath(value);
  if (canonical === undefined || canonical === DEFAULT_REDIRECT) {
    return undefined;
  }
  const pathname = decodedPathname(canonical);
  return pathname === undefined || AUTH_FLOW_PATH.test(pathname)
    ? undefined
    : canonical;
};

/**
 * After a verified sign-in: the organization step sends a new account through
 * onboarding first and everyone else on to the destination.
 */
export const afterSignInNavigation = (
  redirectTo: string,
): NavigateTo<"/auth/organization"> => ({
  to: "/auth/organization",
  search: { redirectTo },
  replace: true,
});

/** An account without an organization sets one up, keeping the destination. */
export const onboardingNavigation = (
  redirectTo: string | undefined,
): NavigateTo<"/onboarding"> => ({
  to: "/onboarding",
  search: { redirectTo: toAppRedirectTo(redirectTo) },
  replace: true,
});

const ONBOARDING_LANDING = "/chat";

/** The end of onboarding: the destination, or chat when there is none. */
export const afterOnboardingNavigation = (
  redirectTo: string | undefined,
): { href: string; replace: boolean } => ({
  href: redirectTo ?? ONBOARDING_LANDING,
  replace: true,
});

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

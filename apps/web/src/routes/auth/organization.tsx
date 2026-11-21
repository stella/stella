import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import {
  getOauthContinuationHref,
  getOauthHashFragment,
  getSignedOauthQueryFromHash,
  hasSignedOauthQuery,
} from "@/lib/oauth-provider";
import {
  destinationNavigation,
  isAcceptInvitationRedirect,
  normalizeRedirectTo,
} from "@/lib/redirect";
import { optionalFlagSearchSchema } from "@/lib/schema";
import { routeSearchSchema } from "@/route-search-params";

import { OrganizationPage } from "./-organization.page";
import { OrganizationPending } from "./-organization.pending";

const searchSchema = routeSearchSchema({
  devQuickStart: optionalFlagSearchSchema,
  redirectTo: v.optional(v.pipe(v.string(), v.transform(normalizeRedirectTo))),
});

export const Route = createFileRoute("/auth/organization")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, location, search }) => {
    const bridgedQuery = getSignedOauthQueryFromHash(location.hash);
    const isOauthPostLoginFromSearch = hasSignedOauthQuery(location.searchStr);

    if (!context.session) {
      if (bridgedQuery) {
        throw redirect({
          href: `/auth#${getOauthHashFragment(bridgedQuery)}`,
          replace: true,
        });
      }

      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }

    const isOauthPostLogin =
      bridgedQuery !== null || isOauthPostLoginFromSearch;

    // A sign-in step hands the authorization on inside `redirectTo`. Picking
    // here would set the organization without it and land on this page again
    // with the request, or on the home page; resume it on this page first.
    const continuation = isOauthPostLogin
      ? null
      : getOauthContinuationHref(search.redirectTo);

    const isDevQuickStart =
      import.meta.env.DEV && search.devQuickStart === true;
    const skipsPicking =
      !isDevQuickStart &&
      !isOauthPostLogin &&
      Boolean(
        context.session.activeOrganizationId ||
        isAcceptInvitationRedirect(search.redirectTo ?? "/"),
      );
    if (continuation !== null || skipsPicking) {
      throw redirect(
        continuation === null
          ? destinationNavigation(search.redirectTo ?? "/")
          : { href: continuation, replace: true },
      );
    }

    return { userId: context.session.userId };
  },
  component: OrganizationPage,
  pendingComponent: OrganizationPending,
});

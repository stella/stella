import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { SIGN_IN_ENTRY_METHOD } from "@/components/auth/sign-in-panel.logic";
import { getSignedOauthQuery, hasOauthPrompt } from "@/lib/oauth-provider";
import { pageTitle } from "@/lib/page-title";
import { normalizeRedirectTo } from "@/lib/redirect";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";
import { getOauthPostLoginRedirectTo } from "@/routes/auth/-index.logic";

import { SignInPage } from "./-index.page";
import { SignInPending } from "./-index.pending";

const searchSchema = routeSearchSchema({
  redirectTo: v.optional(v.pipe(v.string(), v.transform(normalizeRedirectTo))),
  // A link can open the page on the password form (`?method=password`).
  method: v.optional(v.literal(SIGN_IN_ENTRY_METHOD.password)),
  // Direct SP-initiated SSO launch URL (`?sso=<providerId>`).
  sso: v.optional(v.string()),
  // Error code returned by the SSO callback redirect.
  error: v.optional(v.string()),
});

export const Route = createFileRoute("/auth/")({
  staticData: { presentation: routePresentation({ type: "none" }) },
  validateSearch: searchSchema,
  beforeLoad: ({ context, location, search }) => {
    if (context.session && !search.sso && !search.error) {
      // A client that asks for a fresh sign-in gets the form even with a
      // session; the provider resumes the request for whoever signs in.
      if (
        hasOauthPrompt(
          getSignedOauthQuery({
            hash: location.hash,
            searchStr: location.searchStr,
          }),
          "login",
        )
      ) {
        return;
      }

      const oauthRedirectTo = getOauthPostLoginRedirectTo({
        hash: location.hash,
        searchStr: location.searchStr,
      });
      if (oauthRedirectTo) {
        throw redirect({
          href: oauthRedirectTo,
          replace: true,
        });
      }

      throw redirect({
        to: "/auth/organization",
        search: { redirectTo: search.redirectTo ?? "/" },
        replace: true,
      });
    }
  },
  head: () => ({
    meta: [{ title: pageTitle("auth.signIn") }],
  }),
  component: SignInPage,
  pendingComponent: SignInPending,
});

import * as React from "react";

import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import * as v from "valibot";

import { SignInPanel } from "@/components/auth/sign-in-panel";
import {
  getOauthHashFragment,
  getSignedOauthQueryFromHash,
  hasSignedOauthQuery,
} from "@/lib/oauth-provider";
import { pageTitle } from "@/lib/page-title";
import { normalizeRedirectTo } from "@/lib/redirect";

const DevQuickStartButton = import.meta.env.DEV
  ? React.lazy(async () => {
      const module =
        await import("@/routes/auth/-components/dev-quick-start-button");
      return { default: module.DevQuickStartButton };
    })
  : null;

const searchSchema = v.object({
  redirectTo: v.optional(v.pipe(v.string(), v.transform(normalizeRedirectTo))),
});

export const Route = createFileRoute("/auth/")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, location, search }) => {
    if (context.session) {
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
  component: LoginOrSignup,
});

function LoginOrSignup() {
  const defaultRedirectTo = Route.useSearch({
    select: (s) => s.redirectTo ?? "/",
  });
  const location = useLocation({
    select: ({ hash, searchStr }) => ({ hash, searchStr }),
  });
  const redirectTo = getOauthPostLoginRedirectTo(location) ?? defaultRedirectTo;

  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <SignInPanel redirectTo={redirectTo} />
      {DevQuickStartButton === null ? null : (
        <React.Suspense fallback={null}>
          <DevQuickStartButton redirectTo={redirectTo} />
        </React.Suspense>
      )}
    </div>
  );
}

const getOauthPostLoginRedirectTo = ({
  hash,
  searchStr,
}: {
  hash: string;
  searchStr: string;
}) => {
  const bridgedQuery = getSignedOauthQueryFromHash(hash);
  if (bridgedQuery) {
    return `/auth/organization#${getOauthHashFragment(bridgedQuery)}`;
  }

  if (!hasSignedOauthQuery(searchStr)) {
    return null;
  }

  return `/auth/organization${searchStr}`;
};

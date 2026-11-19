import { lazy, Suspense } from "react";

import { getRouteApi, useLocation } from "@tanstack/react-router";

import { SignInPanel } from "@/components/auth/sign-in-panel";

import { getOauthPostLoginRedirectTo } from "./-index.logic";
import { SignInShell } from "./-index.pending";

const route = getRouteApi("/auth/");

const DevQuickStartButton = import.meta.env.DEV
  ? lazy(async () => {
      const module =
        await import("@/routes/auth/-components/dev-quick-start-button");
      return { default: module.DevQuickStartButton };
    })
  : null;

export function SignInPage() {
  const defaultRedirectTo = route.useSearch({
    select: (s) => s.redirectTo ?? "/",
  });
  const entryMethod = route.useSearch({ select: (s) => s.method });
  const location = useLocation({
    select: ({ hash, searchStr }) => ({ hash, searchStr }),
  });
  const redirectTo = getOauthPostLoginRedirectTo(location) ?? defaultRedirectTo;

  return (
    <SignInShell>
      <SignInPanel entryMethod={entryMethod} redirectTo={redirectTo} />
      {DevQuickStartButton === null ? null : (
        <Suspense fallback={null}>
          <DevQuickStartButton redirectTo={redirectTo} />
        </Suspense>
      )}
    </SignInShell>
  );
}

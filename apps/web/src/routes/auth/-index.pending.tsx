import type { PropsWithChildren } from "react";

import { useSearch } from "@tanstack/react-router";

import { SignInPanelPending } from "@/components/auth/sign-in-panel-face.pending";
import { SIGN_IN_ENTRY_METHOD } from "@/components/auth/sign-in-panel.logic";
import {
  isAcceptInvitationRedirect,
  normalizeRedirectTo,
} from "@/lib/redirect";
import { framePendingView } from "@/routes/-pending-view.logic";

export const SignInShell = ({ children }: PropsWithChildren) => (
  <div className="flex w-full max-w-md flex-col gap-4">{children}</div>
);

export const SignInPending = framePendingView(() => {
  const { method, redirectTo } = useSearch({
    strict: false,
    select: (search) => ({
      method: search.method,
      redirectTo: search.redirectTo,
    }),
  });
  // The cold request cannot see a signed OAuth fragment that overrides this
  // search target. Reserve the hint without stating which destination won.
  const reserveInvitationHint =
    typeof redirectTo === "string" &&
    isAcceptInvitationRedirect(normalizeRedirectTo(redirectTo));
  return (
    <SignInShell>
      <SignInPanelPending
        entryMethod={
          method === SIGN_IN_ENTRY_METHOD.password ? method : undefined
        }
        reserveInvitationHint={reserveInvitationHint}
      />
    </SignInShell>
  );
});

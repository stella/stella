import type { PropsWithChildren } from "react";

import { useSearch } from "@tanstack/react-router";

import { SignInPanelPending } from "@/components/auth/sign-in-panel-face.pending";
import { SIGN_IN_ENTRY_METHOD } from "@/components/auth/sign-in-panel.logic";
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
  return (
    <SignInShell>
      <SignInPanelPending
        entryMethod={
          method === SIGN_IN_ENTRY_METHOD.password ? method : undefined
        }
        redirectTo={typeof redirectTo === "string" ? redirectTo : "/"}
      />
    </SignInShell>
  );
});

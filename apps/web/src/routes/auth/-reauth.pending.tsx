import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { SignInPanelPending } from "@/components/auth/sign-in-panel-face.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const ReauthenticateShell = ({
  children,
  message,
}: {
  children: ReactNode;
  message: ReactNode;
}) => (
  <div className="flex w-full max-w-md flex-col gap-4">
    <p>{message}</p>
    {children}
  </div>
);

const ReauthenticatePendingView = () => {
  const redirectTo = useSearch({
    strict: false,
    select: (search) => search.redirectTo,
  });
  return (
    <ReauthenticateShell
      message={
        <PendingText barClassName="w-48" id="auth.reauthenticationRequired" />
      }
    >
      <SignInPanelPending
        redirectTo={typeof redirectTo === "string" ? redirectTo : "/"}
      />
    </ReauthenticateShell>
  );
};

export const ReauthenticatePending = framePendingView(
  ReauthenticatePendingView,
);

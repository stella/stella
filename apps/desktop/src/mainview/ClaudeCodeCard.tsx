import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { ClaudeCodeFailure, ClaudeCodeStatus } from "./claude-code-status";

/** The managed Claude Code sign-in: its state, and what the user can do next. */
export const ClaudeCodeCard = ({
  status,
  actionFailed,
  onSignIn,
  onCancel,
  onOpenSignInPage,
  onSignOut,
}: ClaudeCodeCardProps) => {
  const t = useTranslations("agentSubscriptions");
  const signedInWithEmail =
    status.state === "signed_in" && status.email !== null;
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("claudeCode.title")}</p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
            {signedInWithEmail
              ? t("claudeCode.signedInAs", { email: status.email ?? "" })
              : t(statusMessage(status))}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status.state === "signing_in" && status.signInPage ? (
            <Button onClick={onOpenSignInPage} variant="link">
              {t("claudeCode.openSignInPage")}
            </Button>
          ) : null}
          {status.state === "signing_in" ? (
            <Button onClick={onCancel} variant="outline">
              {t("cancel")}
            </Button>
          ) : null}
          {status.state === "signed_in" || status.state === "api_key" ? (
            <Button onClick={onSignOut} variant="outline">
              {t("claudeCode.signOut")}
            </Button>
          ) : null}
          {status.state === "signed_out" || status.state === "failed" ? (
            <Button onClick={onSignIn}>{t("claudeCode.signIn")}</Button>
          ) : null}
        </div>
      </div>
      {actionFailed ? (
        <p className="text-destructive-foreground text-sm" role="alert">
          {t("notice.actionFailed")}
        </p>
      ) : null}
    </div>
  );
};

type ClaudeCodeCardProps = {
  status: ClaudeCodeStatus;
  actionFailed: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onOpenSignInPage: () => void;
  onSignOut: () => void;
};

const FAILURE_MESSAGES = {
  not_completed: "claudeCode.failure.notCompleted",
  timed_out: "claudeCode.failure.timedOut",
  unavailable: "claudeCode.failure.unavailable",
} as const satisfies Record<ClaudeCodeFailure, `claudeCode.failure.${string}`>;

const STATE_MESSAGES = {
  not_installed: "claudeCode.notInstalled",
  signed_out: "claudeCode.description",
  signing_in: "signingIn",
  signed_in: "claudeCode.signedIn",
  api_key: "claudeCode.apiKey",
} as const satisfies Record<
  Exclude<ClaudeCodeStatus["state"], "failed">,
  string
>;

function statusMessage(status: ClaudeCodeStatus) {
  return status.state === "failed"
    ? FAILURE_MESSAGES[status.reason]
    : STATE_MESSAGES[status.state];
}

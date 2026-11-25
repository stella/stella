import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ClaudeLogoIcon } from "@stll/ui/brand-icons";
import { Button } from "@stll/ui/button";
import { ListItemMedia } from "@stll/ui/list";
import { SettingsRow } from "@stll/ui/settings";

import type { ClaudeCodeFailure, ClaudeCodeStatus } from "./claude-code-status";
import { SignedInLine } from "./SignedInLine";

/** The managed Claude Code sign-in: its state, and what the user can do next. */
export const ClaudeCodeCard = ({
  status,
  install,
  actionFailed,
  target,
  onSignIn,
  onCancel,
  onOpenSignInPage,
  onSignOut,
  onCheckAgain,
}: ClaudeCodeCardProps) => {
  const t = useTranslations("agentSubscriptions");
  // The install line already says the CLI is missing, with its action.
  const showStatus = status.state !== "not_installed" || install === null;
  const footer =
    install === null && !actionFailed ? null : (
      <div className="flex flex-col gap-3">
        {install}
        {actionFailed ? (
          <p className="text-destructive-foreground text-sm" role="alert">
            {t("notice.actionFailed")}
          </p>
        ) : null}
      </div>
    );
  return (
    <SettingsRow
      description={showStatus ? <ClaudeCodeStatusLine status={status} /> : null}
      footer={footer}
      media={
        <ListItemMedia>
          <ClaudeLogoIcon />
        </ListItemMedia>
      }
      target={target}
      title={t("claudeCode.title")}
    >
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
          {t("signOut")}
        </Button>
      ) : null}
      {status.state === "signed_out" || status.state === "failed" ? (
        <Button onClick={onSignIn}>{t("signIn")}</Button>
      ) : null}
      {status.state === "unknown" ? (
        <Button onClick={onCheckAgain} variant="outline">
          {t("claudeCode.checkAgain")}
        </Button>
      ) : null}
    </SettingsRow>
  );
};

/** One line: who is signed in, or why not. */
const ClaudeCodeStatusLine = ({ status }: { status: ClaudeCodeStatus }) => {
  const t = useTranslations("agentSubscriptions");
  switch (status.state) {
    case "signed_in":
      return <SignedInLine email={status.email} />;
    case "failed":
      return t(FAILURE_MESSAGES[status.reason]);
    case "not_installed":
    case "signed_out":
    case "signing_in":
    case "api_key":
    case "unknown":
      return t(STATE_MESSAGES[status.state]);
    default:
      status satisfies never;
      return panic("Unknown Claude Code state");
  }
};

type ClaudeCodeCardProps = {
  status: ClaudeCodeStatus;
  /** The managed CLI's install line; `null` while its status is unknown. */
  install: React.JSX.Element | null;
  actionFailed: boolean;
  /** The name a settings link brings this row into view by. */
  target: string;
  onSignIn: () => void;
  onCancel: () => void;
  onOpenSignInPage: () => void;
  onSignOut: () => void;
  /** Reads the status again; the native side still waits out its backoff. */
  onCheckAgain: () => void;
};

const FAILURE_MESSAGES = {
  not_completed: "claudeCode.failure.notCompleted",
  timed_out: "claudeCode.failure.timedOut",
  unavailable: "claudeCode.failure.unavailable",
} as const satisfies Record<ClaudeCodeFailure, `claudeCode.failure.${string}`>;

const STATE_MESSAGES = {
  not_installed: "claudeCode.notInstalled",
  signed_out: "notSignedIn",
  signing_in: "signingIn",
  api_key: "claudeCode.apiKey",
  unknown: "claudeCode.unknown",
} as const satisfies Record<
  Exclude<ClaudeCodeStatus["state"], "failed" | "signed_in">,
  string
>;

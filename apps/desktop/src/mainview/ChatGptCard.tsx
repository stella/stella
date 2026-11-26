import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { OpenAILogoIcon } from "@stll/ui/brand-icons";
import { Button } from "@stll/ui/button";
import { ListItemMedia } from "@stll/ui/list";
import { SettingsRow } from "@stll/ui/settings";

import type {
  ChatGptFailure,
  ChatGptSignIn,
  ChatGptStatus,
} from "./chatgpt-status";
import { ChatGptPasteCallback } from "./ChatGptPasteCallback";
import { SignedInLine } from "./SignedInLine";

/** The ChatGPT connection: its state, and what the user can do next. */
export const ChatGptCard = ({
  status,
  install,
  notice,
  target,
  onSignIn,
  onCancel,
  onComplete,
  onDisconnect,
  onManageUsage,
}: ChatGptCardProps) => {
  const t = useTranslations("agentSubscriptions");
  const offerNewAccount =
    status.state === "failed" && NEW_ACCOUNT_FAILURES.has(status.reason);
  const accounts =
    status.state === "signing_in" || status.accounts.length === 0 ? null : (
      <div className="flex flex-wrap gap-2">
        {status.accounts.map((account) => (
          <Button
            key={account.id}
            onClick={() => {
              onSignIn({ account: account.id, newAccount: false });
            }}
            variant="outline"
          >
            {t("continueAs", { email: account.email })}
          </Button>
        ))}
      </div>
    );
  const hasFooter =
    accounts !== null ||
    status.state === "signing_in" ||
    install !== null ||
    notice !== null;
  const footer = hasFooter ? (
    <div className="flex flex-col gap-3">
      {accounts}
      {status.state === "signing_in" ? (
        <ChatGptPasteCallback onComplete={onComplete} />
      ) : null}
      {install}
      {notice ? (
        <p
          className="text-destructive-foreground text-sm"
          role={notice === "revocationUnconfirmed" ? "status" : "alert"}
        >
          {t(NOTICE_MESSAGES[notice])}
        </p>
      ) : null}
    </div>
  ) : null;
  return (
    <SettingsRow
      description={<ChatGptStatusLine status={status} />}
      footer={footer}
      media={
        <ListItemMedia>
          <OpenAILogoIcon />
        </ListItemMedia>
      }
      target={target}
      title={t("chatGpt")}
    >
      {status.state === "signing_in" ? (
        <Button onClick={onCancel} variant="outline">
          {t("cancel")}
        </Button>
      ) : null}
      {status.state === "connected" ? (
        <Button onClick={onManageUsage} variant="link">
          {t("manageUsage")}
        </Button>
      ) : null}
      {status.sessionStored ? (
        <Button onClick={onDisconnect} variant="outline">
          {t("signOut")}
        </Button>
      ) : null}
      {offerNewAccount ? (
        <Button
          onClick={() => {
            onSignIn({ newAccount: true });
          }}
          variant="outline"
        >
          {t("useDifferentAccount")}
        </Button>
      ) : null}
      {status.state === "signing_in" || status.state === "connected" ? null : (
        <Button
          onClick={() => {
            onSignIn({ newAccount: false });
          }}
        >
          {t("signIn")}
        </Button>
      )}
    </SettingsRow>
  );
};

/** One line: who is signed in, or why not. */
const ChatGptStatusLine = ({ status }: { status: ChatGptStatus }) => {
  const t = useTranslations("agentSubscriptions");
  switch (status.state) {
    case "connected":
      return <SignedInLine email={status.email} />;
    case "signed_out":
      return t("notSignedIn");
    case "signing_in":
      return t("signingIn");
    case "needs_reconnect":
      return t("needsReconnect");
    case "failed":
      return t(FAILURE_MESSAGES[status.reason]);
    default:
      status satisfies never;
      return panic("Unknown ChatGPT state");
  }
};

export type ChatGptNotice =
  "actionFailed" | "pasteRejected" | "revocationUnconfirmed";

type ChatGptCardProps = {
  status: ChatGptStatus;
  /** The managed Codex CLI's install line; `null` while its status is unknown. */
  install: React.JSX.Element | null;
  notice: ChatGptNotice | null;
  /** The name a settings link brings this row into view by. */
  target: string;
  onSignIn: (request: ChatGptSignIn) => void;
  onCancel: () => void;
  onComplete: (url: string) => Promise<boolean>;
  onDisconnect: () => void;
  onManageUsage: () => void;
};

const FAILURE_MESSAGES = {
  declined: "failure.declined",
  plan_usage_not_granted: "failure.planUsageNotGranted",
  different_account: "failure.differentAccount",
  state_mismatch: "failure.stateMismatch",
  timed_out: "failure.timedOut",
  browser_unavailable: "failure.browserUnavailable",
  callback_unavailable: "failure.callbackUnavailable",
  registration_incomplete: "failure.registrationIncomplete",
  code_expired: "failure.codeExpired",
  verification: "failure.verification",
  client_rejected: "failure.clientRejected",
  unreachable: "failure.unreachable",
  storage: "failure.storage",
} as const satisfies Record<ChatGptFailure, `failure.${string}`>;

const NOTICE_MESSAGES = {
  actionFailed: "notice.actionFailed",
  pasteRejected: "notice.pasteRejected",
  revocationUnconfirmed: "notice.revocationUnconfirmed",
} as const satisfies Record<ChatGptNotice, `notice.${string}`>;

/** Failures a fresh registration can fix. */
const NEW_ACCOUNT_FAILURES = new Set<ChatGptFailure>([
  "different_account",
  "client_rejected",
]);

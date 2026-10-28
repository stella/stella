import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { ChatGptFailure, ChatGptStatus } from "./chatgpt-status";
import { ChatGptPasteCallback } from "./ChatGptPasteCallback";

/** The ChatGPT connection: its state, and what the user can do next. */
export const ChatGptCard = ({
  status,
  notice,
  onSignIn,
  onCancel,
  onComplete,
  onDisconnect,
  onManageUsage,
}: ChatGptCardProps) => {
  const t = useTranslations("agentSubscriptions");
  const offerNewAccount =
    status.state === "failed" && NEW_ACCOUNT_FAILURES.has(status.reason);
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("chatGpt")}</p>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
            {t(statusMessage(status), {
              email: status.state === "connected" ? (status.email ?? "") : "",
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status.state === "signing_in" ? (
            <Button onClick={onCancel} variant="outline">
              {t("cancel")}
            </Button>
          ) : null}
          {status.state === "connected" ? (
            <>
              <Button onClick={onManageUsage} variant="link">
                {t("manageUsage")}
              </Button>
              <Button onClick={onDisconnect} variant="outline">
                {t("disconnect")}
              </Button>
            </>
          ) : null}
          {offerNewAccount ? (
            <Button
              onClick={() => {
                onSignIn(true);
              }}
              variant="outline"
            >
              {t("useDifferentAccount")}
            </Button>
          ) : null}
          {status.state === "signing_in" ||
          status.state === "connected" ? null : (
            <Button
              onClick={() => {
                onSignIn(false);
              }}
            >
              {t("continueWithChatGpt")}
            </Button>
          )}
        </div>
      </div>
      {status.state === "signing_in" ? (
        <ChatGptPasteCallback onComplete={onComplete} />
      ) : null}
      {notice ? (
        <p
          className="text-destructive-foreground text-sm"
          role={notice === "revocationUnconfirmed" ? "status" : "alert"}
        >
          {t(NOTICE_MESSAGES[notice])}
        </p>
      ) : null}
    </div>
  );
};

export type ChatGptNotice =
  "actionFailed" | "pasteRejected" | "revocationUnconfirmed";

type ChatGptCardProps = {
  status: ChatGptStatus;
  notice: ChatGptNotice | null;
  onSignIn: (newAccount: boolean) => void;
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

function statusMessage(status: ChatGptStatus) {
  if (status.state === "failed") {
    return FAILURE_MESSAGES[status.reason];
  }
  if (status.state === "connected") {
    return status.email ? "connectedAs" : "connected";
  }
  if (status.state === "signing_in") {
    return "signingIn";
  }
  if (status.state === "needs_reconnect") {
    return "needsReconnect";
  }
  return "description";
}

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  type ChatLocalRunNotice,
  type ChatLocalRunNoticeCapability,
  chatLocalRunNoticeKey,
  chatLocalRunNoticesOf,
  endedChatLocalRunNotices,
  isChatLocalRunNoticeShown,
} from "@stll/api-contract/chat-local-run-notice";

import type { ChatMessageMetadata } from "@/components/chat/chat-ui-tools-types";
import type { TranslationKey } from "@/i18n/types";

type AnswerContextNotice = NonNullable<ChatMessageMetadata["contextNotice"]>;

const CONTEXT_NOTICE_KEYS = {
  "history-trimmed": "chat.historyTrimmed",
  "session-not-resumed": "chat.localRun.sessionNotResumed",
} as const satisfies Record<AnswerContextNotice["type"], TranslationKey>;

/**
 * Says what the answer's context left out: the server attaches the notice to
 * the answer while it streams and stores it with the answer, so it reads the
 * same live and after reload.
 */
export const ContextNotice = ({
  metadata,
}: {
  metadata: ChatMessageMetadata | undefined;
}) => {
  const t = useTranslations();
  // `null` is the live stream withdrawing a replaced attempt's notice.
  const notice = metadata?.contextNotice;
  if (notice === undefined || notice === null) {
    return null;
  }
  return (
    <p className="text-muted-foreground max-w-xl py-1 text-xs" role="status">
      {t(CONTEXT_NOTICE_KEYS[notice.type])}
    </p>
  );
};

/**
 * Names the files a local run could not share. The server stores them with the
 * answer and the live stream carries the same list, so it reads the same live
 * and after reload.
 */
export const LocalRunFilesNotSharedNotice = ({
  metadata,
}: {
  metadata: ChatMessageMetadata | undefined;
}) => {
  const t = useTranslations();
  const fileNames = metadata?.localRunFilesNotShared;
  if (fileNames === undefined || fileNames.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground max-w-xl py-1 text-xs" role="status">
      {t("chat.localRun.filesNotShared", {
        fileNames: fileNames.join(", "),
      })}
    </p>
  );
};

/** What each capability the run went without reads as. */
const CAPABILITY_UNAVAILABLE_KEYS = {
  browser: "chat.localRun.notices.browserUnavailable",
} as const satisfies Record<ChatLocalRunNoticeCapability, TranslationKey>;

/** One notice in the member's words; `null` for one with nothing to say. */
const useNoticeText = () => {
  const t = useTranslations();
  return (notice: ChatLocalRunNotice): string | null => {
    switch (notice.kind) {
      case "retrying":
        switch (notice.status) {
          case "retrying":
            return notice.attempt === null || notice.maxAttempts === null
              ? t("chat.localRun.notices.retrying")
              : t("chat.localRun.notices.retryingAttempt", {
                  attempt: notice.attempt,
                  maxAttempts: notice.maxAttempts,
                });
          case "recovered":
            return t("chat.localRun.notices.recovered");
          case "ended":
            // The turn's own failure or stop says what became of it.
            return null;
          default:
            notice.status satisfies never;
            return panic("Unknown retry status");
        }
      case "config_warning":
        return t("chat.localRun.notices.configWarning");
      case "capability_unavailable":
        return t(CAPABILITY_UNAVAILABLE_KEYS[notice.capability]);
      default:
        notice satisfies never;
        return panic("Unknown local run notice");
    }
  };
};

/**
 * What the answer's local run said about itself while it went on: a retry of
 * the model, a warning about the agent's settings, a capability it went
 * without. Quiet lines, not errors: the server keeps each one updated on the
 * answer (one line per condition; a retry that recovers reads as recovered,
 * one that ended with its turn reads as nothing), so the answer reads the
 * same live and after reload. Once the turn is no longer running, a retry
 * the stream left under way (a stop cut it off) reads as ended, as the
 * stored answer has it. One polite live region announces a change without
 * interrupting.
 */
export const LocalRunNotices = ({
  isTurnActive,
  metadata,
}: {
  isTurnActive: boolean;
  metadata: ChatMessageMetadata | undefined;
}) => {
  const text = useNoticeText();
  const reported = chatLocalRunNoticesOf(metadata);
  if (reported.length === 0) {
    return null;
  }
  const notices = isTurnActive
    ? reported
    : (endedChatLocalRunNotices(reported) ?? reported);
  const lines = notices.filter(isChatLocalRunNoticeShown).flatMap((notice) => {
    const shown = text(notice);
    return shown === null
      ? []
      : [{ key: chatLocalRunNoticeKey(notice), text: shown }];
  });
  return (
    <div aria-live="polite" role="status">
      {lines.map((line) => (
        <p
          className="text-muted-foreground max-w-xl py-1 text-xs"
          key={line.key}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
};

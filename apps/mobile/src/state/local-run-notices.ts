import { panic } from "better-result";

import {
  type ChatLocalRunNotice,
  type ChatLocalRunNoticeCapability,
  chatLocalRunNoticeKey,
  endedChatLocalRunNotices,
} from "@stll/api-contract/chat-local-run-notice";

/**
 * One line of what a run on the person's computer said about itself: the
 * `chat` catalog's message for it, with the retry's count where the harness
 * gave one, in the words the web uses.
 */
export type LocalRunNoticeLine = {
  readonly id: string;
} & (
  | {
      readonly message:
        | "localRun.notices.retrying"
        | "localRun.notices.recovered"
        | "localRun.notices.configWarning"
        | "localRun.notices.browserUnavailable";
    }
  | {
      readonly message: "localRun.notices.retryingAttempt";
      readonly values: { attempt: number; maxAttempts: number };
    }
);

/** What each capability the run went without reads as. */
const CAPABILITY_MESSAGES = {
  browser: "localRun.notices.browserUnavailable",
} as const satisfies Record<ChatLocalRunNoticeCapability, string>;

/** The line a notice reads as; `null` for one with nothing to say. */
export const localRunNoticeLine = (
  notice: ChatLocalRunNotice,
): LocalRunNoticeLine | null => {
  const id = chatLocalRunNoticeKey(notice);
  switch (notice.kind) {
    case "retrying":
      switch (notice.status) {
        case "retrying":
          return notice.attempt === null || notice.maxAttempts === null
            ? { id, message: "localRun.notices.retrying" }
            : {
                id,
                message: "localRun.notices.retryingAttempt",
                values: {
                  attempt: notice.attempt,
                  maxAttempts: notice.maxAttempts,
                },
              };
        case "recovered":
          return { id, message: "localRun.notices.recovered" };
        case "ended":
          // The turn's own failure or stop says what became of it.
          return null;
        default:
          notice.status satisfies never;
          return panic("Unknown retry status");
      }
    case "config_warning":
      return { id, message: "localRun.notices.configWarning" };
    case "capability_unavailable":
      return { id, message: CAPABILITY_MESSAGES[notice.capability] };
    default:
      notice satisfies never;
      return panic("Unknown local run notice");
  }
};

/**
 * The lines an answer's notices read as. An answer no longer arriving (a
 * stop cut its stream off) reads a retry still under way as ended, as the
 * stored answer has it.
 */
export const localRunNoticeLines = (
  notices: readonly ChatLocalRunNotice[],
  live: boolean,
): LocalRunNoticeLine[] =>
  (live ? notices : (endedChatLocalRunNotices(notices) ?? notices)).flatMap(
    (notice) => {
      const line = localRunNoticeLine(notice);
      return line === null ? [] : [line];
    },
  );

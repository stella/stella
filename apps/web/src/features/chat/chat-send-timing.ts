import type { ChatClientState } from "@tanstack/ai-client";
import { panic } from "better-result";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { startKeyActionTimer } from "@/lib/analytics/key-action-timing";
import type { KeyActionTimer } from "@/lib/analytics/key-action-timing";
import type { Analytics, ChatTimingSurface } from "@/lib/analytics/types";

type TimedTurn = {
  firstToken: KeyActionTimer;
  firstTokenSeen: boolean;
  total: KeyActionTimer;
  userMessageId: string;
};

const hasAssistantText = (
  messages: readonly PersistedChatMessage[],
  userMessageId: string,
): boolean => {
  const sentAt = messages.findLastIndex(
    (message) => message.id === userMessageId,
  );
  if (sentAt === -1) {
    return false;
  }
  return messages
    .slice(sentAt + 1)
    .some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) => part.type === "text" && part.content.trim().length > 0,
        ),
    );
};

/**
 * Times one sent message as the page sees it: until the first reply text
 * renders, and until the request settles. A turn that errors, is stopped or
 * left reports nothing, so the timings describe answered messages only.
 */
export const createChatSendTiming = (
  analytics: () => Pick<Analytics, "captureKeyActionTiming">,
  now?: () => number,
) => {
  let turn: TimedTurn | undefined;
  const drop = () => {
    turn?.firstToken.cancel();
    turn?.total.cancel();
    turn = undefined;
  };
  return {
    started: (
      surface: ChatTimingSurface | undefined,
      userMessageId: string,
    ) => {
      drop();
      if (surface === undefined) {
        return;
      }
      turn = {
        firstToken: startKeyActionTimer(
          analytics(),
          { action: "chat-first-token", surface },
          { now },
        ),
        firstTokenSeen: false,
        total: startKeyActionTimer(
          analytics(),
          { action: "chat-total", surface },
          { now },
        ),
        userMessageId,
      };
    },
    messagesChanged: (messages: readonly PersistedChatMessage[]) => {
      if (turn === undefined || turn.firstTokenSeen) {
        return;
      }
      if (hasAssistantText(messages, turn.userMessageId)) {
        // Reported only once the turn settles: a reply that then errors or
        // is stopped is not an answered message.
        turn.firstTokenSeen = true;
        turn.firstToken.mark();
      }
    },
    statusChanged: (status: ChatClientState) => {
      switch (status) {
        case "submitted":
        case "streaming":
          return;
        case "ready":
          if (turn?.firstTokenSeen === true) {
            turn.firstToken.finish();
          } else {
            // A reply without text (a tool card alone) has no first token.
            turn?.firstToken.cancel();
          }
          turn?.total.finish();
          turn = undefined;
          return;
        case "error":
          drop();
          return;
        default:
          status satisfies never;
          panic("Unhandled chat client state");
      }
    },
    abandoned: drop,
  };
};

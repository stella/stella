import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Result } from "better-result";
import { AppState } from "react-native";

import { CHAT_THREAD_READ_STATE } from "@stll/api-contract/chat";

import { writeFailure } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { setChatThreadReadState } from "@/state/chat-threads";

type MarkChatReadWhileOpenOptions = {
  /** Whether an answer is still arriving; it is read once it has settled. */
  answer: "settled" | "streaming";
  matterId: string | undefined;
  /**
   * What the reader sees of the thread: its newest stored message's id,
   * null before it has one. Each revision is marked at most once.
   */
  revision: string | null;
  source: AccessTokenSource;
  threadId: string;
};

/**
 * Keeps the open chat read: once no answer is arriving and the app is in
 * front, marks it read. Each revision is marked at most once, whatever the
 * outcome, so a failed mark never repeats in a loop; a new answer, or
 * opening the chat again, marks it again. The server then tells the
 * reader's devices through the event stream, whose refresh moves the list
 * here too. A mark that fails is handed back for `WriteFailureNotice`.
 */
export const useMarkChatReadWhileOpen = ({
  answer,
  matterId,
  revision,
  source,
  threadId,
}: MarkChatReadWhileOpenOptions): WriteFailure | null => {
  const { end } = useSession();
  const marked = useRef<string | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);

  const mark = useEffectEvent((key: string) => {
    marked.current = key;
    void setChatThreadReadState({
      fetch,
      matterId,
      readState: CHAT_THREAD_READ_STATE.read,
      source,
      threadId,
    }).then((outcome) => {
      if (Result.isOk(outcome)) {
        setFailure(null);
        return undefined;
      }
      if (outcome.error._tag === "SignedOutError") {
        end(source);
        return undefined;
      }
      setFailure(writeFailure(outcome.error));
      return undefined;
    });
  });

  useEffect(() => {
    if (answer === "streaming" || revision === null) {
      return undefined;
    }
    const key = JSON.stringify([matterId ?? null, threadId, revision]);
    if (marked.current === key) {
      return undefined;
    }
    if (AppState.currentState === "active") {
      mark(key);
      return undefined;
    }
    // Arrived while the app was away: read once the reader is back.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        subscription.remove();
        mark(key);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [answer, matterId, revision, threadId]);

  return failure;
};

import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { fetch as streamingFetch } from "expo/fetch";
import { AppState } from "react-native";

import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import type { ChatEntry } from "@/state/chat-messages";
import {
  applyChatEvent,
  cancelChatTurn,
  EMPTY_ANSWER,
  joinChatTurn,
  probeChatTurn,
  sendChatMessage,
} from "@/state/chat-stream";
import type {
  AnswerStatus,
  ChatEvent,
  StreamBreak,
  StreamedAnswer,
  StreamEnd,
} from "@/state/chat-stream";

/** A turn on screen: the message it answers (when this phone sent it) and the answer so far. */
export type LiveTurn = {
  readonly question: ChatEntry | undefined;
  readonly answer: StreamedAnswer;
  readonly startedAt: string;
};

/** How long a turn the server is still preparing waits before it is asked again. */
const PREPARING_RETRY_MS = 1000;

type Connection = {
  readonly controller: AbortController;
  turnId: string | undefined;
  lastEventId: string | undefined;
  /** The stream broke while the app was away; rejoin when it returns. */
  dropped: boolean;
};

const nowIso = () => new Date(epochMilliseconds()).toISOString();

const newConnection = (turnId: string | undefined): Connection => ({
  controller: new AbortController(),
  turnId,
  lastEventId: undefined,
  dropped: false,
});

/**
 * One thread's turn: sending a message and streaming the answer, stopping
 * it, and picking it up again. A phone loses its connection whenever the
 * app leaves the screen, so a stream that ends before its run did is not an
 * error: the turn is asked where it stands and rejoined after the last event
 * read, now or when the app is active again. A turn already answering when
 * the thread opened is joined from its start. `onSettled` runs once the
 * answer is over, to load the stored thread in its place; when it did, the
 * live turn gives way to it.
 */
export const useChatTurn = ({
  activeTurnId,
  anonymized,
  matterId,
  onSettled,
  source,
  threadId,
}: {
  activeTurnId: string | null;
  /** The thread has sent anonymized text, so a message sent now is anonymized too. */
  anonymized: boolean;
  matterId: string | undefined;
  onSettled: () => Promise<boolean>;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const { end } = useSession();
  // What every request about this thread names.
  const thread = { matterId, source, threadId };
  const turn = useLiveTurn(activeTurnId);
  const { connection } = turn;
  const [sendFailed, setSendFailed] = useState(false);

  const finish = async (opened: Connection, status?: AnswerStatus) => {
    turn.close(status);
    if (await onSettled()) {
      turn.clear(opened);
    }
  };

  const signedOut = (error: ApiError) => {
    if (error._tag !== "SignedOutError") {
      return false;
    }
    end(source);
    return true;
  };

  const current = (opened: Connection) =>
    connection.current === opened && !opened.controller.signal.aborted;

  const settle = async (
    opened: Connection,
    read: Result<StreamEnd, StreamBreak>,
  ) => {
    if (!current(opened)) {
      return;
    }
    // A broken stream still names the last event it delivered, so the
    // rejoin does not draw those events a second time.
    const { lastEventId } = Result.isOk(read) ? read.value : read.error;
    opened.lastEventId = lastEventId;
    if (Result.isError(read) && signedOut(read.error.error)) {
      return;
    }
    if (turn.answer.current.status === "streaming") {
      await rejoin(opened);
      return;
    }
    await finish(opened);
  };

  const rejoin = async (opened: Connection): Promise<void> => {
    const known = opened.turnId;
    if (!current(opened)) {
      return;
    }
    if (known === undefined) {
      await finish(opened, "failed");
      return;
    }
    if (AppState.currentState !== "active") {
      opened.dropped = true;
      return;
    }
    opened.dropped = false;
    const probe = await probeChatTurn({
      ...thread,
      fetch,
      turnId: known,
    });
    if (!current(opened)) {
      return;
    }
    if (Result.isError(probe)) {
      // Offline for now; the next return to the app asks again.
      opened.dropped = !signedOut(probe.error);
      return;
    }
    switch (probe.value) {
      case "preparing": {
        setTimeout(() => {
          void rejoin(opened);
        }, PREPARING_RETRY_MS);
        return;
      }
      case "transcript": {
        await finish(opened);
        return;
      }
      case "running": {
        const read = await joinChatTurn({
          ...thread,
          fetch: streamingFetch,
          lastEventId: opened.lastEventId,
          onEvent: turn.applyEvent,
          signal: opened.controller.signal,
          turnId: known,
        });
        await settle(opened, read);
        return;
      }
    }
  };

  /**
   * Sends `text`, unless a turn is still answering. `onRefused` hands the
   * text back when the server never took it, so it can be sent again.
   */
  const send = (text: string, onRefused: () => void): boolean => {
    if (connection.current !== null) {
      return false;
    }
    setSendFailed(false);
    const messageId = randomUUID();
    const opened = turn.open({
      id: messageId,
      role: "user",
      createdAt: nowIso(),
      text,
      tools: [],
    });
    void (async () => {
      const read = await sendChatMessage({
        ...thread,
        anonymized,
        fetch: streamingFetch,
        messageId,
        onEvent: turn.applyEvent,
        onTurn: (accepted) => {
          turn.accept(opened, accepted);
        },
        runId: randomUUID(),
        signal: opened.controller.signal,
        text,
      });
      if (
        Result.isError(read) &&
        opened.turnId === undefined &&
        current(opened)
      ) {
        turn.close();
        turn.clear(opened);
        if (!signedOut(read.error.error)) {
          setSendFailed(true);
          onRefused();
        }
        return;
      }
      await settle(opened, read);
    })();
    return true;
  };

  /** Asks the server to stop the turn; its stream then ends with the answer stopped. */
  const stop = () => {
    const { turnId } = turn;
    if (turnId === undefined) {
      return;
    }
    void (async () => {
      const stopped = await cancelChatTurn({
        ...thread,
        fetch,
        turnId,
      });
      // Any other failure leaves the answer streaming, so Stop stays offered.
      if (Result.isError(stopped)) {
        signedOut(stopped.error);
      }
    })();
  };

  const joinActiveTurn = useEffectEvent(() => {
    if (activeTurnId === null) {
      return;
    }
    void rejoin(turn.join(activeTurnId));
  });

  const returnToApp = useEffectEvent(() => {
    const opened = connection.current;
    if (opened?.dropped === true) {
      void rejoin(opened);
    }
  });

  const leave = useEffectEvent(() => {
    connection.current?.controller.abort();
  });

  useEffect(() => {
    joinActiveTurn();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        returnToApp();
      }
    });
    return () => {
      subscription.remove();
      leave();
    };
  }, []);

  return {
    busy: turn.busy,
    canStop: turn.turnId !== undefined,
    live: turn.live,
    send,
    sendFailed,
    stop,
  };
};

/**
 * What the screen draws of a turn, and the connection behind it. The
 * answer is kept in a ref beside its state too: a stream's end is handled
 * in the same callback that read its last event, before React has rendered
 * it. A turn the thread opened on starts out live, joined by the effect.
 */
function useLiveTurn(activeTurnId: string | null) {
  const [live, setLive] = useState<LiveTurn | null>(() =>
    activeTurnId === null
      ? null
      : { question: undefined, answer: EMPTY_ANSWER, startedAt: nowIso() },
  );
  const [busy, setBusy] = useState(activeTurnId !== null);
  const [turnId, setTurnId] = useState(activeTurnId ?? undefined);
  const connection = useRef<Connection | null>(null);
  // The connection whose turn is on screen. It outlives `connection`, which
  // is let go as soon as the answer ends, while the thread is still reloading.
  const shownFor = useRef<Connection | null>(null);
  const answer = useRef<StreamedAnswer>(EMPTY_ANSWER);

  const showAnswer = (next: StreamedAnswer) => {
    answer.current = next;
    setLive((shown) => (shown === null ? shown : { ...shown, answer: next }));
  };

  return {
    answer,
    busy,
    connection,
    live,
    turnId,
    applyEvent: (event: ChatEvent) => {
      showAnswer(applyChatEvent(answer.current, event));
    },
    /** A new turn for `question`, replacing any still connected. */
    open: (question: ChatEntry): Connection => {
      connection.current?.controller.abort();
      const opened = newConnection(undefined);
      connection.current = opened;
      shownFor.current = opened;
      answer.current = EMPTY_ANSWER;
      setLive({ question, answer: EMPTY_ANSWER, startedAt: nowIso() });
      setBusy(true);
      setTurnId(undefined);
      return opened;
    },
    /** A connection to the turn the thread opened on, which starts out live. */
    join: (known: string): Connection => {
      const opened = newConnection(known);
      connection.current = opened;
      shownFor.current = opened;
      return opened;
    },
    /** The server named the turn, so it can be stopped and rejoined. */
    accept: (opened: Connection, accepted: string) => {
      opened.turnId = accepted;
      setTurnId(accepted);
    },
    /** The turn is over, ending as `status` when the stream did not say. */
    close: (status?: AnswerStatus) => {
      if (status !== undefined) {
        showAnswer({ ...answer.current, status });
      }
      connection.current = null;
      setBusy(false);
      setTurnId(undefined);
    },
    /**
     * Takes `opened`'s turn off the screen. A message sent while the thread
     * was reloading has opened a newer turn, which stays.
     */
    clear: (opened: Connection) => {
      if (shownFor.current !== opened) {
        return;
      }
      shownFor.current = null;
      setLive(null);
    },
  };
}

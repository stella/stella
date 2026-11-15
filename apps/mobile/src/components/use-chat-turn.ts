import { useEffect, useEffectEvent, useRef, useState } from "react";

import { panic, Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { fetch as streamingFetch } from "expo/fetch";
import { AppState } from "react-native";

import type { ChatLocalRunSteerRefusal } from "@stll/api-contract/chat-run-target";

import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { sendRefusal } from "@/state/chat-attachments";
import type { ChatDraft, SendRefusal } from "@/state/chat-attachments";
import { sentEntry } from "@/state/chat-messages";
import type { ChatEntry, ChatRetry } from "@/state/chat-messages";
import { continuationOf } from "@/state/chat-pending-input";
import type { PendingAnswer, PendingInput } from "@/state/chat-pending-input";
import {
  applyChatEvent,
  cancelChatTurn,
  continueChatTurn,
  EMPTY_ANSWER,
  joinChatTurn,
  probeChatTurn,
  regenerateChatTurn,
  sendChatMessage,
  steerChatTurn,
} from "@/state/chat-stream";
import type {
  AnswerStatus,
  ChatEvent,
  StreamBreak,
  StreamedAnswer,
  StreamEnd,
} from "@/state/chat-stream";

/**
 * A turn on screen: the message it answers (when this phone sent it), the
 * answer so far, and the stored message it continues, when it resumes a
 * paused turn. That message stays on screen above what the new run adds.
 * A turn that answers the latest message again `replaces` the stored
 * answer that failed, which leaves the screen while it runs.
 */
export type LiveTurn = {
  readonly question: ChatEntry | undefined;
  readonly answer: StreamedAnswer;
  readonly startedAt: string;
  readonly continues: string | undefined;
  readonly replaces: string | undefined;
};

/** How a new turn stands to a stored message: adding to it, or in its place. */
type StoredLink = {
  readonly type: "continues" | "replaces";
  readonly messageId: string;
};

/**
 * What became of a message steered into the running turn: the agent took it
 * (`steered`), it did not and says why (`refused`), or the turn ended before
 * either (`unsettled`).
 */
type SteerOutcome =
  | { readonly type: "steered" }
  | { readonly type: "refused"; readonly reason: ChatLocalRunSteerRefusal }
  | { readonly type: "unsettled" };

/** What a paused turn waits for, when this phone can give it. */
type AnswerablePendingInput = Exclude<PendingInput, { type: "elsewhere" }>;

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
  const [sendError, setSendError] = useState<SendRefusal>();

  const signedOut = (error: ApiError) => {
    if (error._tag !== "SignedOutError") {
      return false;
    }
    end(source);
    return true;
  };

  const { rejoin, start } = turnStreams({ onSettled, signedOut, thread, turn });

  /**
   * Sends the draft, unless a turn is still answering. `onRefused` hands the
   * draft back when the server never took it, so it can be sent again.
   */
  const send = (draft: ChatDraft, onRefused: () => void): boolean => {
    if (connection.current !== null) {
      return false;
    }
    setSendError(undefined);
    const messageId = randomUUID();
    const opened = turn.open(
      sentEntry({ createdAt: nowIso(), draft, messageId }),
    );
    start(
      opened,
      async () =>
        await sendChatMessage({
          ...thread,
          ...draft,
          anonymized,
          fetch: streamingFetch,
          messageId,
          onEvent: turn.applyEvent,
          onTurn: (accepted) => {
            turn.accept(opened, accepted);
          },
          runId: randomUUID(),
          signal: opened.controller.signal,
        }),
      (error) => {
        setSendError(sendRefusal(error, draft.files.length > 0));
        onRefused();
      },
    );
    return true;
  };

  /**
   * Answers what a paused turn waits for, unless a turn is still answering:
   * the answer resumes the turn in a new run, streamed like a send.
   * `onAccepted` runs once the server has taken the answer; `onRefused` when
   * it did not (the turn was answered elsewhere, or the request failed), so
   * the thread can be read again to tell which.
   */
  const answer = (
    pending: AnswerablePendingInput,
    reply: PendingAnswer,
    {
      onAccepted,
      onRefused,
    }: { readonly onAccepted: () => void; readonly onRefused: () => void },
  ): boolean => {
    const settles = continuationOf(pending, reply);
    if (connection.current !== null || settles === undefined) {
      return false;
    }
    setSendError(undefined);
    const opened = turn.open(undefined, {
      type: "continues",
      messageId: pending.messageId,
    });
    start(
      opened,
      async () =>
        await continueChatTurn({
          ...thread,
          anonymized,
          continuation: {
            messageId: pending.messageId,
            parentRunId: pending.parentRunId,
            ...settles,
          },
          fetch: streamingFetch,
          onEvent: turn.applyEvent,
          onTurn: (accepted) => {
            turn.accept(opened, accepted);
            onAccepted();
          },
          runId: randomUUID(),
          runTarget:
            pending.owner.type === "harness"
              ? pending.owner.runTarget
              : undefined,
          signal: opened.controller.signal,
        }),
      onRefused,
    );
    return true;
  };

  /**
   * Answers the thread's latest message again once its answer failed,
   * unless a turn is still answering. A refusal before the server named a
   * turn is shown where a send's is; the message stays in the thread.
   */
  const regenerate = (retry: ChatRetry): boolean => {
    if (connection.current !== null) {
      return false;
    }
    setSendError(undefined);
    const opened = turn.open(undefined, {
      type: "replaces",
      messageId: retry.answerId,
    });
    start(
      opened,
      async () =>
        await regenerateChatTurn({
          ...thread,
          anonymized,
          fetch: streamingFetch,
          onEvent: turn.applyEvent,
          onTurn: (accepted) => {
            turn.accept(opened, accepted);
          },
          retry,
          runId: randomUUID(),
          signal: opened.controller.signal,
        }),
      (error) => {
        setSendError(sendRefusal(error, false));
      },
    );
    return true;
  };

  /**
   * Follows a turn the server is running that this phone did not start,
   * such as the one an answer given elsewhere resumed, which continues the
   * stored message `continues`.
   */
  const follow = (turnId: string, continues: string | undefined) => {
    if (connection.current !== null) {
      return;
    }
    void rejoin(turn.follow(turnId, continues));
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
    answer,
    busy: turn.busy,
    canStop: turn.turnId !== undefined,
    follow,
    live: turn.live,
    regenerate,
    send,
    sendError,
    ...useTurnSteer({ send, signedOut, thread, turn }),
    stop,
  };
};

/**
 * Hands a draft to the turn answering now, which goes on with it at the
 * agent's next step, unless no turn of this phone runs or the draft holds
 * files (only text is steered). `onRefused` hands the draft back when the
 * agent did not take it, with `steerRefusal` saying why. A turn that ends
 * before it said takes the draft as the next message instead (`send`).
 */
function useTurnSteer({
  send,
  signedOut,
  thread,
  turn,
}: {
  send: (draft: ChatDraft, onRefused: () => void) => boolean;
  signedOut: (error: ApiError) => boolean;
  thread: { source: AccessTokenSource; threadId: string };
  turn: ReturnType<typeof useLiveTurn>;
}) {
  const [steerRefusal, onRefusal] = useState<ChatLocalRunSteerRefusal>();
  const steer = (draft: ChatDraft, onRefused: () => void): boolean => {
    const { turnId } = turn;
    if (turnId === undefined || draft.files.length > 0) {
      return false;
    }
    onRefusal(undefined);
    const inputId = randomUUID();
    const settled = turn.awaitSteer(inputId);
    void (async () => {
      const asked = await steerChatTurn({
        ...thread,
        fetch,
        inputId,
        text: draft.text,
        turnId,
      });
      // A failed request may still have reached the computer: the turn's
      // stream or its end settles the steer, never a guess.
      if (Result.isError(asked)) {
        signedOut(asked.error);
      } else if (asked.value.type === "refused") {
        turn.settleSteer(inputId, asked.value);
      }
      const outcome = await settled;
      switch (outcome.type) {
        case "steered":
          return;
        case "refused":
          onRefusal(outcome.reason);
          onRefused();
          return;
        case "unsettled":
          if (!send(draft, onRefused)) {
            onRefused();
          }
          return;
        default:
          outcome satisfies never;
          return panic("Unhandled steer outcome");
      }
    })();
    return true;
  };
  return { steer, steerRefusal };
}

/**
 * The stream side of a turn: settling a stream that ended, rejoining one
 * that broke or that the app left, and starting a request whose stream
 * becomes the live turn. A request the server refused before it named a
 * turn takes the turn off the screen and hands the refusal to `onRefused`.
 */
function turnStreams({
  onSettled,
  signedOut,
  thread,
  turn,
}: {
  onSettled: () => Promise<boolean>;
  signedOut: (error: ApiError) => boolean;
  thread: {
    matterId: string | undefined;
    source: AccessTokenSource;
    threadId: string;
  };
  turn: ReturnType<typeof useLiveTurn>;
}) {
  const { connection } = turn;

  const finish = async (opened: Connection, status?: AnswerStatus) => {
    turn.close(status);
    if (await onSettled()) {
      turn.clear(opened);
    }
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

  const start = (
    opened: Connection,
    request: () => Promise<Result<StreamEnd, StreamBreak>>,
    onRefused: (error: ApiError) => void,
  ) => {
    void (async () => {
      const read = await request();
      if (
        Result.isError(read) &&
        opened.turnId === undefined &&
        current(opened)
      ) {
        turn.close();
        turn.clear(opened);
        if (!signedOut(read.error.error)) {
          onRefused(read.error.error);
        }
        return;
      }
      await settle(opened, read);
    })();
  };

  return { rejoin, start };
}

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
      : {
          question: undefined,
          answer: EMPTY_ANSWER,
          startedAt: nowIso(),
          continues: undefined,
          replaces: undefined,
        },
  );
  const [busy, setBusy] = useState(activeTurnId !== null);
  const [turnId, setTurnId] = useState(activeTurnId ?? undefined);
  const connection = useRef<Connection | null>(null);
  // The connection whose turn is on screen. It outlives `connection`, which
  // is let go as soon as the answer ends, while the thread is still reloading.
  const shownFor = useRef<Connection | null>(null);
  const answer = useRef<StreamedAnswer>(EMPTY_ANSWER);
  /** Steers waiting to hear from the running turn, by input id. */
  const steers = useRef(new Map<string, (outcome: SteerOutcome) => void>());

  const settleSteer = (inputId: string, outcome: SteerOutcome) => {
    const settle = steers.current.get(inputId);
    steers.current.delete(inputId);
    settle?.(outcome);
  };

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
      if (event.type === "CUSTOM") {
        const { inputId, status } = event.value;
        settleSteer(
          inputId,
          status === "steered"
            ? { type: "steered" }
            : { type: "refused", reason: "not_taken" },
        );
        return;
      }
      showAnswer(applyChatEvent(answer.current, event));
    },
    /** What the running turn makes of steer `inputId`, once it says. */
    awaitSteer: async (inputId: string): Promise<SteerOutcome> =>
      await new Promise<SteerOutcome>((resolve) => {
        steers.current.set(inputId, resolve);
      }),
    settleSteer,
    /**
     * A new turn, replacing any still connected: one answering `question`,
     * or one linked to a stored message, which it continues or replaces.
     */
    open: (question: ChatEntry | undefined, link?: StoredLink): Connection => {
      connection.current?.controller.abort();
      const opened = newConnection(undefined);
      connection.current = opened;
      shownFor.current = opened;
      answer.current = EMPTY_ANSWER;
      setLive({
        question,
        answer: EMPTY_ANSWER,
        startedAt: nowIso(),
        continues: link?.type === "continues" ? link.messageId : undefined,
        replaces: link?.type === "replaces" ? link.messageId : undefined,
      });
      setBusy(true);
      setTurnId(undefined);
      return opened;
    },
    /** A turn the server is running already, which `continues` a stored message. */
    follow: (known: string, continues: string | undefined): Connection => {
      connection.current?.controller.abort();
      const opened = newConnection(known);
      connection.current = opened;
      shownFor.current = opened;
      answer.current = EMPTY_ANSWER;
      setLive({
        question: undefined,
        answer: EMPTY_ANSWER,
        startedAt: nowIso(),
        continues,
        replaces: undefined,
      });
      setBusy(true);
      setTurnId(known);
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
      // The turn is over: a steer it never answered was not taken.
      for (const inputId of [...steers.current.keys()]) {
        settleSteer(inputId, { type: "unsettled" });
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

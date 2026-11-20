import { panic } from "better-result";

import type { ChatTurnTiming } from "./chat";

type TimingMessage = {
  id: string;
  metadata?: { turnTiming?: ChatTurnTiming | null | undefined } | undefined;
};

// Receipt anchors belong to the runtime, so hiding/remounting a label does not
// restart its clock. Weak keys release observations when messages are discarded.
const receivedAtByTiming = new WeakMap<ChatTurnTiming, number>();

export const createChatTurnTimingObserver = () => {
  const observations = new Map<
    string,
    { observedAt: string; receivedAt: number }
  >();
  return (messages: readonly TimingMessage[], now: number) => {
    const messageIds = new Set<string>();
    for (const message of messages) {
      messageIds.add(message.id);
      const timing = message.metadata?.turnTiming;
      if (timing?.status !== "running") {
        observations.delete(message.id);
        continue;
      }
      const previous = observations.get(message.id);
      const observation =
        previous && previous.observedAt === timing.observedAt
          ? previous
          : { observedAt: timing.observedAt, receivedAt: now };
      observations.set(message.id, observation);
      receivedAtByTiming.set(timing, observation.receivedAt);
    }
    for (const id of observations.keys()) {
      if (!messageIds.has(id)) {
        observations.delete(id);
      }
    }
  };
};

export const getChatTurnDurationMs = (
  timing: ChatTurnTiming,
  now: number,
): number | undefined => {
  if (!Number.isFinite(timing.durationMs) || timing.durationMs < 0) {
    return undefined;
  }
  switch (timing.status) {
    case "finished":
      return timing.durationMs;
    case "running": {
      const receivedAt = receivedAtByTiming.get(timing);
      if (receivedAt === undefined) {
        return undefined;
      }
      if (
        !Number.isFinite(timing.elapsedMs) ||
        timing.elapsedMs < 0 ||
        !Number.isFinite(now)
      ) {
        return undefined;
      }
      // A new reading can precede the label's next clock synchronization.
      return (
        timing.durationMs + timing.elapsedMs + Math.max(0, now - receivedAt)
      );
    }
    default: {
      timing satisfies never;
      return panic("Unhandled chat turn timing");
    }
  }
};

/** A short reading of elapsed time: whole seconds, or whole minutes. */
export type ChatElapsedReading = {
  readonly unit: "second" | "minute";
  readonly value: number;
};

/** A live clock says nothing for its first seconds; most steps end sooner. */
const LIVE_ELAPSED_SHOWN_AFTER_MS = 5000;

/**
 * How long a run of steps took, or has been running, as its summary line
 * shows it: seconds up to 59, then whole minutes ("1 min", "2 min"). A live
 * reading counts whole seconds and shows nothing for its first
 * `LIVE_ELAPSED_SHOWN_AFTER_MS`; a settled one rounds, and is never zero.
 */
export const chatElapsedReading = (
  durationMs: number,
  { live }: { readonly live: boolean },
): ChatElapsedReading | null => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (live && durationMs < LIVE_ELAPSED_SHOWN_AFTER_MS) {
    return null;
  }
  const seconds = live
    ? Math.floor(durationMs / 1000)
    : Math.max(1, Math.round(durationMs / 1000));
  return seconds < 60
    ? { unit: "second", value: seconds }
    : { unit: "minute", value: Math.floor(seconds / 60) };
};

export const getChatTurnDurationUnits = (durationMs: number) => {
  const totalSeconds = Math.floor(durationMs / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
};

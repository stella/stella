import { panic } from "better-result";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";

type TurnTiming = NonNullable<
  NonNullable<ChatMessage["metadata"]>["turnTiming"]
>;

// Receipt anchors belong to the runtime, so hiding/remounting a label does not
// restart its clock. Weak keys release observations when messages are discarded.
const receivedAtByTiming = new WeakMap<TurnTiming, number>();

export const createChatTurnTimingObserver = () => {
  const observations = new Map<
    string,
    { observedAt: string; receivedAt: number }
  >();
  return (messages: readonly ChatMessage[], now: number) => {
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
        previous?.observedAt === timing.observedAt
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
  timing: TurnTiming,
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
        return panic("Running chat timing has no receipt observation");
      }
      if (
        !Number.isFinite(timing.elapsedMs) ||
        timing.elapsedMs < 0 ||
        !Number.isFinite(now) ||
        now < receivedAt
      ) {
        return undefined;
      }
      return timing.durationMs + timing.elapsedMs + now - receivedAt;
    }
    default: {
      timing satisfies never;
      return panic("Unhandled chat turn timing");
    }
  }
};

export const getChatTurnDurationUnits = (durationMs: number) => {
  const totalSeconds = Math.floor(durationMs / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
};

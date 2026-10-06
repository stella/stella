import { panic } from "better-result";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import { parseDeterministicDate } from "@/lib/deterministic-date";

type TurnTiming = NonNullable<
  NonNullable<ChatMessage["metadata"]>["turnTiming"]
>;

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
      const startedAt = parseDeterministicDate(timing.startedAt)?.getTime();
      if (startedAt === undefined || !Number.isFinite(now) || now < startedAt) {
        return undefined;
      }
      return timing.durationMs + now - startedAt;
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

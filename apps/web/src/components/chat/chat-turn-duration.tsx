import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  getChatTurnDurationMs,
  getChatTurnDurationUnits,
} from "@/components/chat/chat-turn-duration.logic";
import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";

type ChatTurnDurationProps = {
  timing: NonNullable<NonNullable<ChatMessage["metadata"]>["turnTiming"]>;
};

export const ChatTurnDuration = ({ timing }: ChatTurnDurationProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [now, setNow] = useState(() => performance.now());
  const observedAt =
    timing.status === "running" ? timing.observedAt : undefined;
  useExternalSyncEffect(() => {
    if (observedAt === undefined) {
      return;
    }
    // Synchronize with the browser's monotonic clock, including a fresh receipt.
    setNow(performance.now());
    const interval = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(interval);
  }, [observedAt]);
  const durationMs = getChatTurnDurationMs(timing, now);
  if (durationMs === undefined) {
    return null;
  }
  const { hours, minutes, seconds } = getChatTurnDurationUnits(durationMs);
  const units = [
    ...(hours > 0
      ? [
          format.number(hours, {
            style: "unit",
            unit: "hour",
            unitDisplay: "narrow",
          }),
        ]
      : []),
    ...(minutes > 0
      ? [
          format.number(minutes, {
            style: "unit",
            unit: "minute",
            unitDisplay: "narrow",
          }),
        ]
      : []),
    format.number(seconds, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
    }),
  ];
  return (
    <p
      className="text-muted-foreground text-xs tabular-nums"
      data-chat-turn-duration
      data-chat-copy-exclude
    >
      {t("chat.workedFor", { duration: units.join(" ") })}
    </p>
  );
};

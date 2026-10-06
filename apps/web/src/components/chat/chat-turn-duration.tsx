import { useNow, useTranslations } from "use-intl";

import {
  getChatTurnDurationMs,
  getChatTurnDurationUnits,
} from "@/components/chat/chat-turn-duration.logic";
import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import { useFormatter } from "@/i18n/formatting-context";

type ChatTurnDurationProps = {
  timing: NonNullable<NonNullable<ChatMessage["metadata"]>["turnTiming"]>;
};

export const ChatTurnDuration = ({ timing }: ChatTurnDurationProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow(
    timing.status === "running" ? { updateInterval: 1000 } : {},
  );
  const durationMs = getChatTurnDurationMs(timing, now.getTime());
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

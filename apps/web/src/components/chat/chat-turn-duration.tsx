import { useTranslations } from "use-intl";

import {
  getChatTurnDurationMs,
  getChatTurnDurationUnits,
} from "@stll/api-contract/chat-turn-duration";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import { useFormatter } from "@/i18n/formatting-context";

type ChatTurnDurationProps = {
  timing: NonNullable<ChatMessage["metadata"]>["turnTiming"];
};

export const ChatTurnDuration = ({ timing }: ChatTurnDurationProps) => {
  if (timing === undefined || timing === null || timing.status === "running") {
    return null;
  }
  return <TimedChatTurnDuration timing={timing} />;
};

type TimedChatTurnDurationProps = {
  timing: Extract<
    NonNullable<ChatTurnDurationProps["timing"]>,
    { status: "finished" }
  >;
};

const TimedChatTurnDuration = ({ timing }: TimedChatTurnDurationProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const durationMs = getChatTurnDurationMs(timing, 0);
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

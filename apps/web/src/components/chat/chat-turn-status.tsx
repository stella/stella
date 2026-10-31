import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { getChatTurnDurationMs } from "@stll/api-contract/chat-turn-duration";
import { Loader } from "@stll/ui/loader";

import {
  type ChatTurnStatusInput,
  type TurnActivePhase,
  turnLiveStatus,
} from "@/components/chat/chat-turn-status.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";

export const ChatTurnStatus = ({ turn }: { turn: ChatTurnStatusInput }) => {
  const status = turnLiveStatus(turn);
  if (status.type === "none") {
    return null;
  }
  return <LiveTurnStatus phase={status.phase} timing={turn.timing} />;
};

const LiveTurnStatus = ({
  phase,
  timing,
}: {
  phase: TurnActivePhase;
  timing: ChatTurnStatusInput["timing"];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [now, setNow] = useState(() => performance.now());
  const observedAt =
    timing?.status === "running" ? timing.observedAt : undefined;
  useExternalSyncEffect(() => {
    if (observedAt === undefined) {
      return undefined;
    }
    setNow(performance.now());
    const interval = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(interval);
  }, [observedAt]);
  const durationMs = timing && getChatTurnDurationMs(timing, now);
  const elapsed = format.number(Math.floor((durationMs ?? 0) / 1000), {
    style: "unit",
    unit: "second",
    unitDisplay: "narrow",
  });

  return (
    <p
      className="text-muted-foreground flex items-center gap-2 text-xs tabular-nums"
      data-chat-copy-exclude
      data-turn-live-status
      role="status"
    >
      <Loader size="sm" variant="decorative" />
      <span>
        {phaseLabel(phase, {
          analyzingSources: t("chat.analyzingSources"),
          thinking: t("chat.thinking"),
          waitingForApproval: t("chat.turnStatus.waitingForApproval"),
          waitingForInput: t("chat.turnStatus.waitingForInput"),
          writing: t("chat.turnStatus.writing"),
        })}
      </span>
      <span>{elapsed}</span>
    </p>
  );
};

type PhaseLabels = {
  analyzingSources: string;
  thinking: string;
  waitingForApproval: string;
  waitingForInput: string;
  writing: string;
};

const phaseLabel = (phase: TurnActivePhase, labels: PhaseLabels): string => {
  switch (phase.type) {
    case "thinking":
      return labels.thinking;
    case "using-tool":
      return phase.label;
    case "analyzing-sources":
      return labels.analyzingSources;
    case "writing":
      return labels.writing;
    case "waiting-for-approval":
      return labels.waitingForApproval;
    case "waiting-for-input":
      return labels.waitingForInput;
    default:
      return panic("Unhandled turn phase", { phase: phase satisfies never });
  }
};

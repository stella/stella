import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { chatElapsedReading } from "@stll/api-contract/chat-turn-duration";
import { Loader } from "@stll/ui/loader";
import { TruncatedText } from "@stll/ui/truncated-text";

import { formatChatElapsed } from "@/components/chat/chat-step-summary";
import {
  type ChatTurnStatusInput,
  liveTurnElapsedMs,
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
  return (
    <LiveTurnStatus
      phase={status.phase}
      sentAt={turn.sentAt}
      timing={turn.timing}
    />
  );
};

const TICK_MS = 1000;

const LiveTurnStatus = ({
  phase,
  sentAt,
  timing,
}: {
  phase: TurnActivePhase;
  sentAt: number | null;
  timing: ChatTurnStatusInput["timing"];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [shownAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());
  // The clock is the external system: the line redraws once a second for as
  // long as the turn runs, whether or not anything streams.
  useExternalSyncEffect(() => {
    const interval = setInterval(() => setNow(performance.now()), TICK_MS);
    return () => clearInterval(interval);
  }, []);
  // Quick turns stay quiet: the clock shows only after a few seconds, then
  // counts seconds and, past a minute, whole minutes.
  const reading = chatElapsedReading(
    liveTurnElapsedMs({ sentAt, timing, shownAt, now }),
    { live: true },
  );

  // Not a live region: it redraws every second and with every step. The
  // thread's `ChatTurnAnnouncer` says when the turn needs the member or ends.
  // A span, so the line can also stand as the label of the run of steps it
  // describes (`AssistantProcessGroup`).
  return (
    <span
      className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs tabular-nums"
      data-chat-copy-exclude
      data-turn-live-status
    >
      <Loader size="sm" variant="decorative" />
      <TruncatedText hint={false} render={<span />}>
        {phaseLabel(phase, {
          analyzingSources: t("chat.analyzingSources"),
          thinking: t("chat.thinking"),
          waitingForApproval: t("chat.turnStatus.waitingForApproval"),
          waitingForInput: t("chat.turnStatus.waitingForInput"),
          writing: t("chat.turnStatus.writing"),
        })}
      </TruncatedText>
      {reading !== null && (
        <span className="shrink-0">{formatChatElapsed(format, reading)}</span>
      )}
    </span>
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

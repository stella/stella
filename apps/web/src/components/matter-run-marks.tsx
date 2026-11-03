import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { StatusMark } from "@stll/ui/status-mark";
import { cn } from "@stll/ui/utils";

import { topMatterRunState } from "@/features/chat/active-runs.logic";
import type {
  ActiveChatRunState,
  MatterRunStatus,
} from "@/features/chat/active-runs.logic";
import { useFormatter } from "@/i18n/formatting-context";

/** The mark for one state; its meaning is named by the element around it. */
const RunStateGlyph = ({
  size,
  state,
}: {
  /** `row` sits in a matter's second line, `badge` on the collapsed icon. */
  size: "badge" | "row";
  state: ActiveChatRunState;
}) => {
  switch (state) {
    case "needs-you":
      return (
        <span
          aria-hidden
          className={cn(
            "text-warning-foreground leading-none font-bold",
            size === "row" ? "text-xs" : "text-3xs",
          )}
        >
          !
        </span>
      );
    case "working":
      return (
        <StatusMark
          className={cn(size === "row" ? "size-3" : "size-2.5")}
          status="running"
        />
      );
    default:
      state satisfies never;
      return panic("Unhandled active chat run state");
  }
};

/**
 * What the reader's chats in a matter are doing, at the end of the matter's
 * second line: chats waiting on the reader first, then chats working. A count
 * follows a mark only when there is more than one. Nothing renders when the
 * matter has no open chat, so quiet matters stay quiet.
 */
export const MatterRunMarks = ({
  status,
}: {
  status: MatterRunStatus | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (status === undefined) {
    return null;
  }
  const marks = [
    {
      count: status.needsYou,
      label: t("chat.matterRuns.needsYou", { count: status.needsYou }),
      state: "needs-you",
    },
    {
      count: status.working,
      label: t("chat.matterRuns.working", { count: status.working }),
      state: "working",
    },
  ] as const satisfies readonly {
    count: number;
    label: string;
    state: ActiveChatRunState;
  }[];
  const shown = marks.filter(({ count }) => count > 0);
  if (shown.length === 0) {
    return null;
  }
  return (
    <span
      className="text-muted-foreground text-3xs flex shrink-0 items-center gap-1.5 leading-none tabular-nums"
      data-slot="matter-run-marks"
    >
      {shown.map(({ count, label, state }) => (
        <span
          aria-label={label}
          className="flex items-center gap-0.5"
          key={state}
          role="img"
        >
          <RunStateGlyph size="row" state={state} />
          {count > 1 ? <span aria-hidden>{format.number(count)}</span> : null}
        </span>
      ))}
    </span>
  );
};

/**
 * The collapsed rail's version: only the state that matters most, as a
 * badge on the matter's icon.
 */
export const MatterRunBadge = ({
  status,
}: {
  status: MatterRunStatus | undefined;
}) => {
  const t = useTranslations();
  const state = topMatterRunState(status);
  if (state === null || status === undefined) {
    return null;
  }
  const label =
    state === "needs-you"
      ? t("chat.matterRuns.needsYou", { count: status.needsYou })
      : t("chat.matterRuns.working", { count: status.working });
  return (
    <span
      aria-label={label}
      className="bg-sidebar absolute -end-1.5 -top-1.5 flex size-3 items-center justify-center rounded-full"
      data-slot="matter-run-badge"
      role="img"
    >
      <RunStateGlyph size="badge" state={state} />
    </span>
  );
};

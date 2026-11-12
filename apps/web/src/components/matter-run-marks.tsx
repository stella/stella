import { useTranslations } from "use-intl";

import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import type { ChatActiveRunState } from "@stll/api-contract/chat";
import { RunStateMark } from "@stll/ui/run-state-mark";

import { topMatterRunState } from "@/features/chat/active-runs.logic";
import type { MatterRunStatus } from "@/features/chat/active-runs.logic";
import { useFormatter } from "@/i18n/formatting-context";

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
}) =>
  topMatterRunState(status) === null || status === undefined ? null : (
    <OpenRunMarks status={status} />
  );

const OpenRunMarks = ({ status }: { status: MatterRunStatus }) => {
  const t = useTranslations();
  const format = useFormatter();
  const marks = [
    {
      count: status.needsYou,
      label: t("chat.matterRuns.needsYou", { count: status.needsYou }),
      state: CHAT_ACTIVE_RUN_STATE.needsYou,
    },
    {
      count: status.working,
      label: t("chat.matterRuns.working", { count: status.working }),
      state: CHAT_ACTIVE_RUN_STATE.working,
    },
  ] as const satisfies readonly {
    count: number;
    label: string;
    state: ChatActiveRunState;
  }[];
  const shown = marks.filter(({ count }) => count > 0);
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
          <RunStateMark size="row" state={state} />
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
    state === CHAT_ACTIVE_RUN_STATE.needsYou
      ? t("chat.matterRuns.needsYou", { count: status.needsYou })
      : t("chat.matterRuns.working", { count: status.working });
  return (
    <span
      aria-label={label}
      className="bg-sidebar absolute -end-1.5 -top-1.5 flex size-3 items-center justify-center rounded-full"
      data-slot="matter-run-badge"
      role="img"
    >
      <RunStateMark size="badge" state={state} />
    </span>
  );
};

import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ChatTurnInteractionType } from "@stll/api-contract/chat";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { StatusMark } from "@stll/ui/status-mark";
import { cn } from "@stll/ui/utils";

import { topMatterRunState } from "@/features/chat/active-runs.logic";
import type {
  ActiveChatRunState,
  MatterRuns,
} from "@/features/chat/active-runs.logic";
import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

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
export const MatterRunMarks = ({ runs }: { runs: MatterRuns | undefined }) =>
  topMatterRunState(runs) === null || runs === undefined ? null : (
    <OpenRunMarks runs={runs} />
  );

const OpenRunMarks = ({ runs }: { runs: MatterRuns }) => {
  const format = useFormatter();
  const counts = useRunCounts(runs);
  return (
    <span
      className="text-muted-foreground text-3xs flex shrink-0 items-center gap-1.5 leading-none tabular-nums"
      data-slot="matter-run-marks"
    >
      {counts.map(({ count, label, state }) => (
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

/** Each state with open chats, waiting first, with its count and label. */
export const useRunCounts = (runs: MatterRuns | undefined) => {
  const t = useTranslations();
  const counts = [
    {
      count: runs?.needsYou.length ?? 0,
      label: t("chat.matterRuns.needsYou", {
        count: runs?.needsYou.length ?? 0,
      }),
      state: "needs-you",
    },
    {
      count: runs?.working.length ?? 0,
      label: t("chat.matterRuns.working", {
        count: runs?.working.length ?? 0,
      }),
      state: "working",
    },
  ] as const satisfies readonly {
    count: number;
    label: string;
    state: ActiveChatRunState;
  }[];
  return counts.filter(({ count }) => count > 0);
};

/**
 * The collapsed rail's version: only the state that matters most, as a
 * badge on the matter's icon. It opens the list of the matter's open chats,
 * each saying what it waits on and linking to it. It sits beside the matter
 * link rather than inside it, positioned over the icon's corner, so it is a
 * control of its own.
 */
export const MatterRunBadge = ({
  runs,
  workspaceId,
}: {
  runs: MatterRuns | undefined;
  workspaceId: string;
}) => {
  const state = topMatterRunState(runs);
  if (state === null || runs === undefined) {
    return null;
  }
  return (
    <MatterRunsPopover runs={runs} state={state} workspaceId={workspaceId} />
  );
};

const MatterRunsPopover = ({
  runs,
  state,
  workspaceId,
}: {
  runs: MatterRuns;
  state: ActiveChatRunState;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const relativeTime = useRelativeTime();
  const [open, setOpen] = useState(false);
  const label = useRunCounts(runs)
    .map((count) => count.label)
    .join(", ");
  const close = () => setOpen(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      {/* Centred on the corner of the rail's 16px icon, which sits 8px into
          its 32px button, where the badge used to be drawn. */}
      <PopoverTrigger
        aria-label={label}
        data-slot="matter-run-badge"
        render={
          <Button
            className="absolute start-3 -top-1 z-10"
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <span className="bg-sidebar flex size-3 items-center justify-center rounded-full">
          <RunStateGlyph size="badge" state={state} />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-72"
        padding="none"
        side="inline-end"
      >
        <ul aria-label={label} className="flex flex-col p-1">
          {runs.needsYou.map((run) => (
            <MatterRunRow
              detail={t(INTERACTION_LABEL_KEY[run.interaction])}
              key={run.threadId}
              onOpen={close}
              since={relativeTime(run.since)}
              state={run.state}
              threadId={run.threadId}
              title={run.threadTitle}
              workspaceId={workspaceId}
            />
          ))}
          {runs.working.map((run) => (
            <MatterRunRow
              detail={t("chat.matterRuns.workingNow")}
              key={run.threadId}
              onOpen={close}
              since={relativeTime(run.since)}
              state={run.state}
              threadId={run.threadId}
              title={run.threadTitle}
              workspaceId={workspaceId}
            />
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
};

const MatterRunRow = ({
  detail,
  onOpen,
  since,
  state,
  threadId,
  title,
  workspaceId,
}: {
  detail: string;
  onOpen: () => void;
  since: string;
  state: ActiveChatRunState;
  threadId: string;
  title: string;
  workspaceId: string;
}) => (
  <li>
    <Link
      className="hover:bg-accent focus-visible:bg-accent flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none"
      onClick={onOpen}
      params={{ threadId, workspaceId }}
      to="/chat/workspaces/$workspaceId/$threadId"
    >
      <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
        <RunStateGlyph size="row" state={state} />
      </span>
      <span className="flex min-w-0 flex-col">
        <BidiText as="span" className="truncate">
          {title}
        </BidiText>
        <span className="text-muted-foreground text-xs">
          {detail} · {since}
        </span>
      </span>
    </Link>
  </li>
);

/** What each kind of wait asks of the reader, in their words. */
const INTERACTION_LABEL_KEY = {
  "ask-user": "chat.matterRuns.waitsOn.askUser",
  approval: "chat.matterRuns.waitsOn.approval",
  "client-tool": "chat.matterRuns.waitsOn.clientTool",
  "harness-question": "chat.matterRuns.waitsOn.harnessQuestion",
} as const satisfies Record<ChatTurnInteractionType, TranslationKey>;

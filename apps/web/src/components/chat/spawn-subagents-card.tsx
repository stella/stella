import {
  CheckIcon,
  CircleDashedIcon,
  LoaderIcon,
  NetworkIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  ChatToolCallPart,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { keySpawnSubagents } from "@/components/chat/spawn-subagents-card.logic";
import { useFormatter } from "@/i18n/formatting-context";

type SpawnSubagentsPart = Extract<
  ChatToolCallPart,
  { name: "spawn_subagents" }
>;

type SpawnSubagentsInput = ChatUITools["spawn_subagents"]["input"];
type SpawnSubagentsOutput = ChatUITools["spawn_subagents"]["output"];

type SpawnSubagentsCardProps = {
  part: SpawnSubagentsPart;
};

export const SpawnSubagentsCard = ({ part }: SpawnSubagentsCardProps) => {
  const t = useTranslations();
  const format = useFormatter();

  // Input is a DeepPartial while streaming; treat as absent until it
  // settles. `part.input` is already parsed/typed upstream.
  const input = part.state !== "input-streaming" ? part.input : undefined;
  const output = part.state === "complete" ? part.output : null;
  const isExecuting = part.state !== "complete";

  if (!input) {
    return (
      <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <NetworkIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="font-medium">{t("chat.tool.spawn_subagents")}</span>
          {isExecuting && (
            <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <NetworkIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">{t("chat.tool.spawn_subagents")}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {format.number(input.subagents.length)}
        </span>
        {isExecuting && (
          <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
        )}
      </div>

      {/* Subtasks */}
      <SpawnSubagentsSubtaskList
        results={output?.results ?? undefined}
        subagents={input.subagents}
      />
    </div>
  );
};

type SpawnSubagentsSubtaskListProps = {
  subagents: SpawnSubagentsInput["subagents"];
  results?: SpawnSubagentsOutput["results"] | undefined;
  /**
   * True while this list is rendered inside the approval card, before the
   * user has approved delegation: no subagent has actually started, so a
   * spinner would misleadingly suggest work is already in progress. Shows a
   * neutral queued marker instead. Defaults to false for the post-approval
   * results card, where "no result yet" does mean the subagent is running.
   */
  isAwaitingApproval?: boolean;
};

export const SpawnSubagentsSubtaskList = ({
  subagents,
  results,
  isAwaitingApproval,
}: SpawnSubagentsSubtaskListProps) => {
  const keyedSubagents = keySpawnSubagents(subagents);

  return (
    <ul className="border-border/50 space-y-2 border-t px-3 py-3">
      {keyedSubagents.map(({ index, key, subagent }) => {
        const result = results?.find((entry) => entry.index === index);
        return (
          <li className="space-y-1.5" key={key}>
            <div className="flex items-start justify-between gap-2">
              <p className="line-clamp-2 text-sm">{subagent.task}</p>
              <SubtaskStatus
                isAwaitingApproval={isAwaitingApproval ?? false}
                status={result?.status}
              />
            </div>

            {subagent.model ? (
              <div className="flex items-center gap-1.5">
                <span className="bg-muted/40 text-muted-foreground rounded px-1.5 py-0.5 text-[11px] font-medium">
                  {subagent.model}
                </span>
              </div>
            ) : null}

            {result?.status === "completed" && result.result && (
              <p className="text-muted-foreground max-h-40 overflow-auto text-xs whitespace-pre-wrap">
                {result.result}
              </p>
            )}

            {result?.status === "failed" && result.error && (
              <p className="text-destructive max-h-40 overflow-auto text-[11px] whitespace-pre-wrap">
                {result.error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
};

type SubtaskStatusProps = {
  isAwaitingApproval: boolean;
  status: "completed" | "failed" | undefined;
};

const SubtaskStatus = ({ isAwaitingApproval, status }: SubtaskStatusProps) => {
  const t = useTranslations();

  if (status === "completed") {
    return (
      <span className="bg-muted/40 text-muted-foreground flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium">
        <CheckIcon className="size-3" />
        {t("common.done")}
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span className="bg-destructive/10 text-destructive border-destructive/60 flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium">
        {t("chat.spawnSubagents.failed")}
      </span>
    );
  }

  if (isAwaitingApproval) {
    return (
      <span className="bg-muted/40 text-muted-foreground flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium">
        <CircleDashedIcon className="size-3" />
      </span>
    );
  }

  return (
    <span className="bg-muted/40 text-muted-foreground flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium">
      <LoaderIcon className="size-3 animate-spin" />
      {t("tasks.statusValues.in_progress")}
    </span>
  );
};

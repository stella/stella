import { panic } from "better-result";
import {
  CheckIcon,
  CircleDashedIcon,
  LoaderIcon,
  NetworkIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  ChatUITools,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";
import {
  getSpawnSubagentsCallStatus,
  keySpawnSubagents,
  SPAWN_SUBAGENTS_CALL_STATUS,
} from "@/components/chat/spawn-subagents-card.logic";
import type { SpawnSubagentsCallStatus } from "@/components/chat/spawn-subagents-card.logic";
import { useFormatter } from "@/i18n/formatting-context";

type SpawnSubagentsPart = Extract<
  RegisteredChatUIToolCallPart,
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
  const callStatus = getSpawnSubagentsCallStatus(part);

  if (!input) {
    return (
      <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <NetworkIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="font-medium">{t("chat.tool.spawn_subagents")}</span>
          <CallStatusIndicator status={callStatus} />
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
        <CallStatusIndicator status={callStatus} />
      </div>

      {/* Subtasks */}
      <SpawnSubagentsSubtaskList
        callStatus={callStatus}
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
   * Status of the whole call. A subtask without a result shows a spinner only
   * while the call runs; before approval or after the call settled it shows
   * a neutral marker, since that subagent is not (or no longer) working.
   */
  callStatus: SpawnSubagentsCallStatus;
};

export const SpawnSubagentsSubtaskList = ({
  callStatus,
  subagents,
  results,
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
              <SubtaskStatus callStatus={callStatus} status={result?.status} />
            </div>

            {subagent.model ? (
              <div className="flex items-center gap-1.5">
                <span className="bg-muted/40 text-muted-foreground text-2xs rounded px-1.5 py-0.5 font-medium">
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
              <p className="text-destructive text-2xs max-h-40 overflow-auto whitespace-pre-wrap">
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
  callStatus: SpawnSubagentsCallStatus;
  status: "completed" | "failed" | undefined;
};

const SubtaskStatus = ({ callStatus, status }: SubtaskStatusProps) => {
  const t = useTranslations();

  if (status === "completed") {
    return (
      <span className="bg-muted/40 text-muted-foreground text-2xs flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium">
        <CheckIcon className="size-3" />
        {t("common.done")}
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span className="bg-destructive/10 text-destructive border-destructive/60 text-2xs flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-medium">
        {t("common.failed")}
      </span>
    );
  }

  if (callStatus !== SPAWN_SUBAGENTS_CALL_STATUS.running) {
    return (
      <span className="bg-muted/40 text-muted-foreground text-2xs flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium">
        <CircleDashedIcon className="size-3" />
      </span>
    );
  }

  return (
    <span className="bg-muted/40 text-muted-foreground text-2xs flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium">
      <LoaderIcon className="size-3 animate-spin" />
      {t("tasks.statusValues.in_progress")}
    </span>
  );
};

type CallStatusIndicatorProps = {
  status: SpawnSubagentsCallStatus;
};

const CallStatusIndicator = ({ status }: CallStatusIndicatorProps) => {
  const t = useTranslations();

  switch (status) {
    case SPAWN_SUBAGENTS_CALL_STATUS.running:
      return (
        <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
      );
    case SPAWN_SUBAGENTS_CALL_STATUS.failed:
      return (
        <span className="bg-destructive/10 text-destructive border-destructive/60 text-2xs ms-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-medium">
          {t("common.failed")}
        </span>
      );
    case SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval:
      return (
        <CircleDashedIcon className="text-muted-foreground ms-auto size-3.5 shrink-0" />
      );
    // A declined call is rendered by the approval card, which names the
    // decline itself.
    case SPAWN_SUBAGENTS_CALL_STATUS.declined:
    case SPAWN_SUBAGENTS_CALL_STATUS.done:
      return null;
    default:
      status satisfies never;
      return panic(`Unhandled spawn_subagents call status: ${String(status)}`);
  }
};

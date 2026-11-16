import type { ComponentProps, ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  spawnSubagentsInputSchema,
  spawnSubagentsOutputSchema,
} from "@stll/api-contract/spawn-subagents";
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";
import { CheckIcon, CircleDashedIcon, SplitIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { TruncatedText } from "@stll/ui/truncated-text";

import { MessageResponse } from "@/components/ai-elements/message";
import { assistantMessageFallbackText } from "@/components/chat/chat-thread-messages.logic";
import type {
  ChatUITools,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";
import {
  getSpawnSubagentsCallStatus,
  keySpawnSubagents,
  maskSubagentIdentifiers,
  SPAWN_SUBAGENTS_CALL_STATUS,
  subagentTitleRuns,
} from "@/components/chat/spawn-subagents-card.logic";
import type { SpawnSubagentsCallStatus } from "@/components/chat/spawn-subagents-card.logic";
import { useFormatter } from "@/i18n/formatting-context";

type SpawnSubagentsPart = Omit<
  Extract<RegisteredChatUIToolCallPart, { name: "spawn_subagents" }>,
  "input" | "output"
> & { input?: unknown; output?: unknown };

type SpawnSubagentsInput = ChatUITools["spawn_subagents"]["input"];
type SpawnSubagentsOutput = ChatUITools["spawn_subagents"]["output"];

type SpawnSubagentsCardProps = {
  part: SpawnSubagentsPart;
  streamdownComponents: ComponentProps<typeof MessageResponse>["components"];
};

export const SpawnSubagentsCard = ({
  part,
  streamdownComponents,
}: SpawnSubagentsCardProps) => {
  const t = useTranslations();
  const format = useFormatter();

  // Persisted calls can predate the current schema; types are no parse proof.
  const parsedInput = v.safeParse(
    spawnSubagentsInputSchema,
    part.state === "input-streaming" ? undefined : part.input,
  );
  const parsedOutput = v.safeParse(
    spawnSubagentsOutputSchema,
    part.state === "complete" ? part.output : undefined,
  );
  const input = parsedInput.success ? parsedInput.output : null;
  const output = parsedOutput.success ? parsedOutput.output : null;
  const callStatus = getSpawnSubagentsCallStatus(part);

  if (!input) {
    return (
      <SubagentsCardShell>
        <SubagentsCardHeader
          sizeLabel={
            output === null ? null : format.number(output.results.length)
          }
          status={<SubagentsCallStatusIndicator status={callStatus} />}
          title={t("chat.tool.spawn_subagents")}
        />
      </SubagentsCardShell>
    );
  }

  return (
    <SubagentsCardShell>
      <SubagentsCardHeader
        sizeLabel={format.number(input.subagents.length)}
        status={<SubagentsCallStatusIndicator status={callStatus} />}
        title={t("chat.tool.spawn_subagents")}
      />

      <SpawnSubagentsSubtaskList
        callStatus={callStatus}
        results={output?.results ?? undefined}
        subagents={input.subagents}
        streamdownComponents={streamdownComponents}
      />
    </SubagentsCardShell>
  );
};

/**
 * The card every delegation shows as: stella's own subagents here, and a
 * coding agent's subagent on the member's computer
 * (`LocalRunSubagentCard`).
 */
export const SubagentsCardShell = ({ children }: { children: ReactNode }) => (
  <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
    {children}
  </div>
);

type SubagentsCardHeaderProps = {
  title: string;
  /** What follows the title on its line, such as what was delegated. */
  detail?: ReactNode;
  /** How much was delegated, formatted for the locale; `null` when unknown. */
  sizeLabel: string | null;
  /** The call's one status, at the line's end. */
  status: ReactNode;
};

export const SubagentsCardHeader = ({
  sizeLabel,
  detail,
  status,
  title,
}: SubagentsCardHeaderProps) => (
  <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
    <SplitIcon
      aria-hidden="true"
      className="text-muted-foreground size-4 shrink-0"
    />
    <span className="shrink-0 font-medium">{title}</span>
    {detail}
    {sizeLabel !== null && (
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {sizeLabel}
      </span>
    )}
    {status}
  </div>
);

type SpawnSubagentsSubtaskListProps = {
  subagents: SpawnSubagentsInput["subagents"];
  results?: SpawnSubagentsOutput["results"] | undefined;
  /**
   * Status of the whole call. A subtask without a result shows a spinner only
   * while the call runs; after the call settled it shows a neutral marker,
   * since that subagent is no longer working.
   */
  callStatus: SpawnSubagentsCallStatus;
  streamdownComponents: SpawnSubagentsCardProps["streamdownComponents"];
};

const SpawnSubagentsSubtaskList = ({
  callStatus,
  subagents,
  results,
  streamdownComponents,
}: SpawnSubagentsSubtaskListProps) => {
  const t = useTranslations();
  const keyedSubagents = keySpawnSubagents(subagents);

  return (
    <ul className="border-border/50 border-t px-3">
      {keyedSubagents.map(({ index, key, subagent }) => {
        const result = results?.find((entry) => entry.index === index);
        return (
          <li key={key}>
            {/* Each result streams rendered Markdown; it mounts only when its
                row is opened, not for every collapsed row of the card. */}
            <Accordion hiddenUntilFound={false}>
              <AccordionItem value="result">
                <AccordionTrigger>
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <TruncatedText
                      className="text-sm"
                      lines={2}
                      render={<bdi />}
                    >
                      {subagentTitleRuns(
                        maskSubagentIdentifiers(subagent.title),
                      ).map((run) => {
                        switch (run.type) {
                          case "citation":
                            return (
                              <bdi dir="ltr" key={run.start}>
                                {run.text}
                              </bdi>
                            );
                          case "text":
                            return run.text;
                          default:
                            run.type satisfies never;
                            return panic(
                              `Unhandled title run: ${String(run.type)}`,
                            );
                        }
                      })}
                    </TruncatedText>
                    <SubtaskStatus
                      callStatus={callStatus}
                      status={result?.status}
                    />
                  </span>
                </AccordionTrigger>
                <AccordionPanel>
                  <div className="space-y-2">
                    {result?.status === "completed" && result.result && (
                      <MessageResponse
                        {...(streamdownComponents === undefined
                          ? {}
                          : { components: streamdownComponents })}
                        fallbackChildren={assistantMessageFallbackText(
                          result.result,
                        )}
                        className="text-sm"
                      >
                        {result.result}
                      </MessageResponse>
                    )}
                    {result?.status === "failed" && result.error && (
                      <p
                        className="text-destructive text-xs whitespace-pre-wrap"
                        dir="auto"
                      >
                        {maskSubagentIdentifiers(result.error)}
                      </p>
                    )}
                    <Accordion hiddenUntilFound={false}>
                      <AccordionItem value="prompt">
                        <AccordionTrigger>
                          {t("chat.toolCall.input")}
                        </AccordionTrigger>
                        <AccordionPanel>
                          {subagent.model && (
                            <bdi className="text-muted-foreground text-2xs">
                              {subagent.model}
                            </bdi>
                          )}
                          <pre
                            className="text-xs wrap-break-word whitespace-pre-wrap"
                            dir="auto"
                          >
                            {maskSubagentIdentifiers(
                              [
                                subagent.task,
                                subagent.context,
                                subagent.expectedOutput,
                              ]
                                .filter(
                                  (text): text is string =>
                                    typeof text === "string" &&
                                    text.trim() !== "",
                                )
                                .join("\n\n"),
                            )}
                          </pre>
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                  </div>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </li>
        );
      })}
    </ul>
  );
};

type SubtaskStatusProps = {
  callStatus: SpawnSubagentsCallStatus;
  status: SpawnSubagentsOutput["results"][number]["status"] | undefined;
};

const SubtaskStatus = ({ callStatus, status }: SubtaskStatusProps) => {
  const t = useTranslations();

  switch (status) {
    case "completed":
      return (
        <span className="bg-muted/40 text-muted-foreground text-2xs flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium">
          <CheckIcon aria-hidden="true" className="size-3" />
          {t("common.done")}
        </span>
      );
    case "failed":
      return (
        <span className="bg-destructive/10 text-destructive border-destructive/60 text-2xs flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-medium">
          {t("common.failed")}
        </span>
      );
    case undefined:
      break;
    default:
      status satisfies never;
      return panic(`Unhandled subagent result status: ${String(status)}`);
  }

  if (callStatus !== SPAWN_SUBAGENTS_CALL_STATUS.running) {
    return (
      <span className="bg-muted/40 text-muted-foreground text-2xs flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium">
        <CircleDashedIcon className="size-3" />
      </span>
    );
  }

  return (
    <span className="bg-muted/40 text-muted-foreground text-2xs flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium">
      <Loader className="size-3" size="sm" variant="decorative" />
      {t("tasks.statusValues.in_progress")}
    </span>
  );
};

type CallStatusIndicatorProps = {
  status: SpawnSubagentsCallStatus;
};

export const SubagentsCallStatusIndicator = ({
  status,
}: CallStatusIndicatorProps) => {
  const t = useTranslations();

  switch (status) {
    case SPAWN_SUBAGENTS_CALL_STATUS.running:
      return (
        <Loader
          className="ms-auto size-3.5 shrink-0"
          label={t("tasks.statusValues.in_progress")}
          size="sm"
        />
      );
    case SPAWN_SUBAGENTS_CALL_STATUS.failed:
      return (
        <span className="bg-destructive/10 text-destructive border-destructive/60 text-2xs ms-auto flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-medium">
          {t("common.failed")}
        </span>
      );
    case SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval:
      return (
        <CircleDashedIcon className="text-muted-foreground ms-auto size-3.5 shrink-0" />
      );
    // Delegation never asks for approval, so the approval states (awaiting,
    // declined) only exist to keep the map total over the SDK's call states.
    case SPAWN_SUBAGENTS_CALL_STATUS.declined:
    case SPAWN_SUBAGENTS_CALL_STATUS.done:
      return null;
    default:
      status satisfies never;
      return panic(`Unhandled spawn_subagents call status: ${String(status)}`);
  }
};

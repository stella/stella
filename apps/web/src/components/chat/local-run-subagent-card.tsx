import { type ReactNode, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { isRunningToolPart } from "@/components/chat/chat-ui-tools";
import {
  type LocalRunStepStanding,
  type LocalRunSubagentStatus,
  localRunSubagentStatus,
  localRunSubagentType,
  localRunToolView,
} from "@/components/chat/local-run-tool.logic";
import {
  SubagentsCallStatusIndicator,
  SubagentsCardHeader,
  SubagentsCardShell,
} from "@/components/chat/spawn-subagents-card";
import { SPAWN_SUBAGENTS_CALL_STATUS } from "@/components/chat/spawn-subagents-card.logic";
import { toolFailureLabelKey } from "@/components/chat/tool-call-card";

type StandingPart = {
  name: string;
  state: Parameters<typeof toolFailureLabelKey>[0]["state"];
  output?: unknown;
};

/** How one step of a local run stands, for its subagent's one status. */
const localRunStepStanding = ({
  name,
  output,
  state,
}: StandingPart): LocalRunStepStanding => {
  if (state === "approval-requested") {
    return "awaiting_approval";
  }
  if (isRunningToolPart({ type: "tool-call", name, state })) {
    return "running";
  }
  const failure = toolFailureLabelKey({ name, output, state });
  switch (failure) {
    case "chat.toolCall.failed":
      return "failed";
    case "chat.toolCall.interrupted":
      return "interrupted";
    case undefined:
      return "done";
    default:
      failure satisfies never;
      return panic("Unhandled tool failure label");
  }
};

const STATUS_BADGE_CLASS =
  "bg-muted/40 text-muted-foreground text-2xs ms-auto flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium";

const SubagentStatus = ({ status }: { status: LocalRunSubagentStatus }) => {
  const t = useTranslations();
  switch (status) {
    case "needs_approval":
      return (
        <span className={STATUS_BADGE_CLASS}>
          {t("chat.turnStatus.waitingForApproval")}
        </span>
      );
    case "interrupted":
      return <span className={STATUS_BADGE_CLASS}>{t("chat.stopped")}</span>;
    // The statuses the cloud delegation card draws too.
    case "running":
      return (
        <SubagentsCallStatusIndicator
          status={SPAWN_SUBAGENTS_CALL_STATUS.running}
        />
      );
    case "failed":
      return (
        <SubagentsCallStatusIndicator
          status={SPAWN_SUBAGENTS_CALL_STATUS.failed}
        />
      );
    case "done":
      return (
        <SubagentsCallStatusIndicator
          status={SPAWN_SUBAGENTS_CALL_STATUS.done}
        />
      );
    default:
      status satisfies never;
      return panic("Unhandled local run subagent status");
  }
};

type LocalRunSubagentGroupProps = {
  /** The subagent's own step. */
  part: StandingPart & { input?: unknown };
  /** Every step the subagent took, the ones shown as cards included. */
  steps: readonly StandingPart[];
  /** The rows of the steps that show inside. */
  rows: readonly ReactNode[];
  /**
   * The subagent's own conversation (what it was told, wrote and reported),
   * read from the computer that ran it once the group is open; `null` while
   * the subagent works. With no rows either, there is nothing to open.
   */
  conversation: ReactNode;
};

/**
 * A subagent a coding agent started on the member's computer: its short
 * description, how many steps it took and its one status, with its own
 * conversation and the steps it took inside. What it was told, wrote and
 * reported stays on that computer: opening the group reads it from there.
 */
export const LocalRunSubagentGroup = ({
  conversation,
  part,
  rows,
  steps,
}: LocalRunSubagentGroupProps) => {
  const t = useTranslations();
  const call = { name: part.name, input: part.input };
  const description = localRunToolView({
    ...call,
    output: undefined,
  })?.subtitle;
  const agentType = localRunSubagentType(call);
  const status = localRunSubagentStatus({
    own: localRunStepStanding(part),
    steps: steps.map(localRunStepStanding),
  });
  // Open while the subagent works, so its steps are seen as they arrive, and
  // folded once it settles; from the member's first click on, as they left it.
  const [chosen, setChosen] = useState<"open" | "closed" | null>(null);
  const isOpen =
    chosen === null
      ? status === "running" || status === "needs_approval"
      : chosen === "open";
  const setIsOpen = (open: boolean) => {
    setChosen(open ? "open" : "closed");
  };
  const header = (
    <SubagentsCardHeader
      sizeLabel={
        steps.length === 0
          ? null
          : t("common.stepCount", { count: steps.length })
      }
      detail={
        <>
          {description?.type === "text" && (
            <TruncatedText
              className="text-muted-foreground min-w-0 text-start"
              render={<bdi />}
            >
              {description.text}
            </TruncatedText>
          )}
          {agentType !== null && (
            <bdi className="text-muted-foreground text-2xs shrink-0">
              {agentType}
            </bdi>
          )}
        </>
      }
      status={<SubagentStatus status={status} />}
      title={t("chat.toolCall.subagent")}
    />
  );
  if (rows.length === 0 && conversation === null) {
    return (
      <SubagentsCardShell>
        <div data-slot="local-run-subagent">{header}</div>
      </SubagentsCardShell>
    );
  }
  return (
    <SubagentsCardShell>
      <div data-slot="local-run-subagent">
        <Collapsible onOpenChange={setIsOpen} open={isOpen}>
          <CollapsibleTrigger
            render={<Button className="flex w-full" variant="plain" />}
          >
            <span className="flex min-h-11 w-full min-w-0 items-center">
              {header}
              <DirectionalIcon
                className={cn(
                  "text-muted-foreground me-3 size-3.5 shrink-0 transition-transform",
                  isOpen && "rotate-90",
                )}
                flip={!isOpen}
                icon={ChevronRightIcon}
              />
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-border/50 flex flex-col gap-1 border-t px-2.5 py-1.5">
              {/* Read from the computer only once the member opens it. */}
              {isOpen && conversation}
              {rows}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </SubagentsCardShell>
  );
};

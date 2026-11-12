import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { CHAT_PENDING_TEXT_CLASS } from "@/components/chat/chat-pending-text";
import {
  type ChatToolCallPart,
  type HarnessChatToolCallPart,
  isRunningToolPart,
} from "@/components/chat/chat-ui-tools";
import {
  type LocalRunStepOutputKind,
  localRunStepOutputKind,
} from "@/components/chat/local-run-tool.logic";
import { CopyControl } from "@/components/copy-control";
import { localRunStepOutputOptions } from "@/features/chat/local-run-step-output";
import {
  diffLines,
  type DiffLineTone,
  isLocalRunStepOutputCut,
} from "@/features/chat/local-run-step-output.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { formatFileSize } from "@/lib/file-size";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

const DIFF_TONE_CLASS = {
  file: "text-foreground font-medium",
  hunk: "text-foreground-ghost",
  added: "text-success",
  removed: "text-destructive",
  context: "text-foreground-muted",
} as const satisfies Record<DiffLineTone, string>;

const Note = ({
  children,
  pending = false,
}: {
  children: ReactNode;
  pending?: boolean;
}) => (
  <p
    className={cn(
      "text-muted-foreground flex items-center gap-2 py-1 text-xs",
      pending && CHAT_PENDING_TEXT_CLASS,
    )}
  >
    {children}
  </p>
);

/** A kept diff, each line in its tone. */
const DiffText = ({ text }: { text: string }) =>
  diffLines(text).map(({ key, line, tone }) => (
    <span className={cn("block", DIFF_TONE_CLASS[tone])} key={key}>
      {line === "" ? " " : line}
    </span>
  ));

/**
 * What a coding agent's step produced on the member's computer, read from
 * stella desktop there as the row opens: the output or diff as it arrives,
 * how much was left out past the cap, or that it is on another computer.
 */
const LocalRunStepOutput = ({
  activeOrganizationId,
  callId,
  kind,
  userId,
}: {
  activeOrganizationId: string;
  callId: string;
  kind: LocalRunStepOutputKind;
  userId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const query = useQuery(
    localRunStepOutputOptions({ activeOrganizationId, userId, callId }),
  );
  const view = queryView(query, { isEmpty: () => false });
  useQueryViewError(view, "LocalRunStepOutput:query");
  const label =
    kind === "diff"
      ? t("chat.toolCall.localOutput.diff")
      : t("chat.toolCall.output");
  const retry = (
    <Button
      onClick={() => {
        detached(query.refetch(), "local-run-step-output.retry");
      }}
      size="xs"
      variant="ghost"
    >
      {t("common.tryAgain")}
    </Button>
  );
  switch (view.type) {
    case "pending":
      return <Note pending>{t("chat.toolCall.localOutput.reading")}</Note>;
    case "error":
      return (
        <Note>
          {t("chat.toolCall.localOutput.failed")}
          {retry}
        </Note>
      );
    case "empty":
      return panic("A step's output read is never empty");
    case "items":
      break;
    default:
      view satisfies never;
      return panic("Unhandled step output view");
  }
  const output = view.items;
  switch (output.status) {
    case "elsewhere":
      // stella desktop may have been started since: the member can look
      // again without reopening the row.
      return (
        <Note>
          {t("chat.toolCall.localOutput.elsewhere")}
          {retry}
        </Note>
      );
    case "not-kept":
      return <Note>{t("chat.toolCall.localOutput.notKept")}</Note>;
    case "shown":
      break;
    default:
      output satisfies never;
      return panic("Unhandled step output status");
  }
  const reading = query.fetchStatus === "fetching";
  // A read cut off after it began keeps what arrived, but never reads as
  // the whole output.
  const interrupted =
    view.refetchError === undefined ? null : (
      <Note>
        {t("chat.toolCall.localOutput.failed")}
        {retry}
      </Note>
    );
  if (output.text === "" && !reading) {
    return interrupted ?? <Note>{t("chat.toolCall.localOutput.empty")}</Note>;
  }
  return (
    <section aria-label={label} className="group/code relative" dir="ltr">
      <div
        className="absolute end-1 top-1 opacity-0 transition-opacity duration-150 group-hover/code:opacity-100 focus-within:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100"
        data-chat-copy-exclude
      >
        <CopyControl
          iconOnly
          size="icon-xs"
          text={output.text}
          variant="muted"
        />
      </div>
      <ScrollArea className="max-h-96">
        <pre
          aria-busy={reading}
          className="text-foreground-muted py-1 pe-8 font-mono text-xs leading-5"
        >
          {kind === "diff" ? <DiffText text={output.text} /> : output.text}
        </pre>
      </ScrollArea>
      {interrupted}
      {isLocalRunStepOutputCut(output.totalBytes) && (
        <Note>
          {t("chat.toolCall.localOutput.cut", {
            kept: formatFileSize(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES, format),
            total: formatFileSize(output.totalBytes, format),
          })}
        </Note>
      )}
    </section>
  );
};

/**
 * A tool row's details for what a coding agent's settled step produced on
 * the member's computer: a command's output or a change's diff. Nothing for
 * any other call, or for a step still running.
 */
export const LocalRunStepOutputDetails = ({
  activeOrganizationId,
  part,
}: {
  activeOrganizationId: string;
  part: ChatToolCallPart | HarnessChatToolCallPart;
}) => {
  const user = useMaybeAuthenticatedUser();
  const kind = localRunStepOutputKind(part.name);
  if (
    kind === null ||
    user === null ||
    part.output === undefined ||
    isRunningToolPart(part)
  ) {
    return null;
  }
  return (
    <LocalRunStepOutput
      activeOrganizationId={activeOrganizationId}
      callId={part.id}
      kind={kind}
      userId={user.id}
    />
  );
};

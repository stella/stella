import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  type ChatLocalRunConversationEntry,
} from "@stll/api-contract/chat-local-run-step-output";
import {
  type LocalRunStepOutputKind,
  localRunStepOutputKind,
  localRunToolView,
} from "@stll/api-contract/chat-local-run-steps";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { CHAT_PENDING_TEXT_CLASS } from "@/components/chat/chat-pending-text";
import { isRunningToolPart } from "@/components/chat/chat-ui-tools";
import { CopyControl } from "@/components/copy-control";
import {
  localRunStepImageOptions,
  localRunStepOutputOptions,
} from "@/features/chat/local-run-step-output";
import {
  diffLines,
  type DiffLineTone,
  isLocalRunStepOutputCut,
  localRunConversationEntries,
} from "@/features/chat/local-run-step-output.logic";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
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

/** A kept diff, each line in its tone up to a bound, the rest as one block. */
const DiffText = ({ text }: { text: string }) => {
  const { lines, rest } = diffLines(text);
  return (
    <>
      {lines.map(({ key, line, tone }) => (
        <span className={cn("block", DIFF_TONE_CLASS[tone])} key={key}>
          {line === "" ? " " : line}
        </span>
      ))}
      {rest !== "" && <span className="block">{rest}</span>}
    </>
  );
};

/** The step outputs kept and read as text. */
type LocalRunStepTextKind = Exclude<LocalRunStepOutputKind, "image">;

const TEXT_KIND_LABEL_KEYS = {
  command: "chat.toolCall.output",
  diff: "chat.toolCall.localOutput.diff",
  conversation: "chat.toolCall.localOutput.conversation",
} as const satisfies Record<LocalRunStepTextKind, TranslationKey>;

/** Who said a piece of a subagent's conversation; what it wrote is unnamed. */
const CONVERSATION_ROLE_LABEL_KEYS = {
  prompt: "chat.toolCall.localOutput.conversationPrompt",
  message: null,
  report: "chat.toolCall.localOutput.conversationReport",
} as const satisfies Record<
  ChatLocalRunConversationEntry["role"],
  TranslationKey | null
>;

/**
 * A subagent's kept conversation: what it was told, what it wrote, what it
 * reported. Plain text throughout: it came from a model, so none of it is
 * rendered as markup.
 */
const ConversationText = ({ text }: { text: string }) => {
  const t = useTranslations();
  return (
    <ol className="flex flex-col gap-2 py-1">
      {localRunConversationEntries(text).map(({ key, role, text: said }) => {
        const labelKey = CONVERSATION_ROLE_LABEL_KEYS[role];
        return (
          <li className="flex flex-col gap-0.5" key={key}>
            {labelKey !== null && (
              <span className="text-muted-foreground text-2xs font-medium">
                {t(labelKey)}
              </span>
            )}
            <p
              className="text-foreground-muted text-xs leading-5 wrap-break-word whitespace-pre-wrap"
              dir="auto"
            >
              {said}
            </p>
          </li>
        );
      })}
    </ol>
  );
};

/**
 * What a coding agent's step produced on the member's computer, read from
 * stella desktop there as the row opens: the output, diff or conversation as
 * it arrives, how much was left out past the cap, or that it is on another
 * computer.
 */
const LocalRunStepOutput = ({
  activeOrganizationId,
  callId,
  kind,
  userId,
}: {
  activeOrganizationId: string;
  callId: string;
  kind: LocalRunStepTextKind;
  userId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const query = useQuery(
    localRunStepOutputOptions({ activeOrganizationId, userId, callId }),
  );
  const view = queryView(query, { isEmpty: () => false });
  useQueryViewError(view, "LocalRunStepOutput:query");
  const label = t(TEXT_KIND_LABEL_KEYS[kind]);
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
  const cut = isLocalRunStepOutputCut(output.totalBytes) && (
    <Note>
      {t("chat.toolCall.localOutput.cut", {
        kept: formatFileSize(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES, format),
        total: formatFileSize(output.totalBytes, format),
      })}
    </Note>
  );
  if (kind === "conversation") {
    return (
      <section aria-busy={reading} aria-label={label}>
        <ScrollArea className="max-h-96">
          <ConversationText text={output.text} />
        </ScrollArea>
        {interrupted}
        {cut}
      </section>
    );
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
      {cut}
    </section>
  );
};

/**
 * The image a step viewed, read whole from stella desktop on this computer
 * as the row opens, and shown as the kind its bytes name: never run, never
 * through the API. An image past what the computer keeps says so.
 */
const LocalRunStepImage = ({
  activeOrganizationId,
  callId,
  name,
  userId,
}: {
  activeOrganizationId: string;
  callId: string;
  /** The file's name as the step's row shows it. */
  name: string;
  userId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const query = useQuery(
    localRunStepImageOptions({ activeOrganizationId, userId, callId }),
  );
  const view = queryView(query, { isEmpty: () => false });
  useQueryViewError(view, "LocalRunStepImage:query");
  const retry = (
    <Button
      onClick={() => {
        detached(query.refetch(), "local-run-step-image.retry");
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
      return panic("A step's image read is never empty");
    case "items":
      break;
    default:
      view satisfies never;
      return panic("Unhandled step image view");
  }
  const image = view.items;
  switch (image.status) {
    case "elsewhere":
      return (
        <Note>
          {t("chat.toolCall.localOutput.elsewhere")}
          {retry}
        </Note>
      );
    case "not-kept":
    case "not-image":
      return <Note>{t("chat.toolCall.localOutput.notKept")}</Note>;
    case "incomplete":
      return (
        <Note>
          {t("chat.toolCall.localOutput.failed")}
          {retry}
        </Note>
      );
    case "too-large":
      return (
        <Note>
          {t("chat.toolCall.localOutput.imageTooLarge", {
            kept: formatFileSize(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES, format),
            total: formatFileSize(image.totalBytes, format),
          })}
        </Note>
      );
    case "shown":
      return (
        <img
          alt={name}
          className="border-border/50 max-h-96 max-w-full rounded-sm border object-contain"
          src={image.src}
        />
      );
    default:
      image satisfies never;
      return panic("Unhandled step image status");
  }
};

/** A tool call as much as tells what it kept: any call of a turn fits. */
type StepOutputPart = {
  id: string;
  name: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

/**
 * What a settled step of a coding agent kept on the member's computer for
 * them to open, or `null`: any other call, or a step still running.
 */
export const localRunStepOutputKindOf = ({
  input,
  name,
  output,
  state,
}: StepOutputPart): LocalRunStepOutputKind | null =>
  output === undefined || isRunningToolPart({ type: "tool-call", name, state })
    ? null
    : localRunStepOutputKind({ name, input });

/**
 * A tool row's details for what a coding agent's settled step produced on
 * the member's computer: a command's output, a change's diff, a subagent's
 * conversation, or the image a step viewed. Nothing for any other call, or
 * for a step still running.
 */
export const LocalRunStepOutputDetails = ({
  activeOrganizationId,
  part,
}: {
  activeOrganizationId: string;
  part: StepOutputPart;
}) => {
  const user = useMaybeAuthenticatedUser();
  const kind = localRunStepOutputKindOf(part);
  if (kind === null || user === null) {
    return null;
  }
  if (kind === "image") {
    const shown = localRunToolView({
      name: part.name,
      input: part.input,
      output: undefined,
    })?.subtitle;
    return (
      <LocalRunStepImage
        activeOrganizationId={activeOrganizationId}
        callId={part.id}
        name={shown?.type === "text" ? shown.text : ""}
        userId={user.id}
      />
    );
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

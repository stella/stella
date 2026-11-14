import { type ContextType, createContext, type ReactNode, use } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import {
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  chatLocalRunStepContentCap,
} from "@stll/api-contract/chat-local-run-step-content";
import type { ChatLocalRunConversationEntry } from "@stll/api-contract/chat-local-run-step-output";
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
import { MarkdownPreview } from "@/components/markdown-preview";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { localRunStepOutputOptions } from "@/features/chat/local-run-step-output";
import {
  diffLines,
  type DiffLineTone,
  localRunConversationEntries,
  type LocalRunStepOutputView,
} from "@/features/chat/local-run-step-output.logic";
import type { ForkProvenance } from "@/features/chat/queries";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { formatFileSize } from "@/lib/file-size";
import { queryView } from "@/lib/query-view.logic";
import { type SafeId, toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";
import { getUserFileContentUrl } from "@/lib/user-files";

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

/** A stored diff, each line in its tone up to a bound, the rest as one block. */
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

const TEXT_KIND_LABEL_KEYS = {
  command: "chat.toolCall.output",
  diff: "chat.toolCall.localOutput.diff",
  conversation: "chat.toolCall.localOutput.conversation",
} as const satisfies Record<
  Exclude<LocalRunStepOutputKind, "image">,
  TranslationKey
>;

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
 * A subagent's stored conversation: what it was told, what it wrote, what it
 * reported, formatted as the answer it belongs to is. It came from a model,
 * so opening it must not make a request it names: `MarkdownPreview` draws no
 * image from an address, only its alternative text.
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
            <div className="text-foreground-muted wrap-break-word" dir="auto">
              <MarkdownPreview className="text-xs leading-5" mode="static">
                {said}
              </MarkdownPreview>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

/**
 * The fork a thread was made as, if any: a step whose content its copy has
 * yet to bring offers to complete it by asking for the same fork again.
 */
export const LocalRunForkSourceContext = createContext<Extract<
  ForkProvenance,
  { type: "parent" }
> | null>(null);

/** The fork source a thread's provenance names, for `LocalRunForkSourceContext`. */
export const localRunForkSourceOf = (provenance: ForkProvenance) =>
  provenance.type === "parent" ? provenance : null;

type StepContentProps = {
  activeOrganizationId: string;
  callId: string;
  /** The file's name as the step's row shows it, for an image. */
  name: string;
  threadId: SafeId<"chatThread">;
  userId: string;
};

type ForkSource = NonNullable<ContextType<typeof LocalRunForkSourceContext>>;

/** Asks for the thread's fork again, which completes its copy of the steps. */
const CopyToFork = ({
  activeOrganizationId,
  source,
  threadId,
  userId,
}: Pick<StepContentProps, "activeOrganizationId" | "threadId" | "userId"> & {
  source: ForkSource;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const sourceThreadId = toSafeId<"chatThread">(source.threadId);
  const copy = useCapabilityMutation({
    capability: "chat.fork.create",
    target: resourceRef({
      type: RESOURCE_TYPE.CHAT_THREAD,
      id: sourceThreadId,
    }),
    mutationFn: async (_variables, request) =>
      unwrapApiResponse(
        await api.chat.threads({ threadId: sourceThreadId }).fork.post(
          {
            newThreadId: threadId,
            upToMessageId: toSafeId<"chatMessage">(source.messageId),
          },
          {
            ...request,
            query:
              source.workspaceId === null
                ? {}
                : { workspaceId: toSafeId<"workspace">(source.workspaceId) },
          },
        ),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.localRunStepOutputs({
          activeOrganizationId,
          userId,
          threadId,
        }),
      });
    },
    onError: (error) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "LocalRunStepContent:copy",
        scope: { type: "handler", handlerId: "LocalRunStepContent:copy" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  return (
    <Button
      disabled={copy.isPending}
      onClick={() => {
        copy.mutate();
      }}
      size="xs"
      variant="ghost"
    >
      {t("chat.toolCall.localOutput.copyToFork")}
    </Button>
  );
};

/** The copy action, where the fork's source is known. */
const CopyToForkButton = (
  props: Pick<StepContentProps, "activeOrganizationId" | "threadId" | "userId">,
) => {
  const source = use(LocalRunForkSourceContext);
  return source === null ? null : <CopyToFork {...props} source={source} />;
};

/** A stored text step: the output, diff or conversation, as it is read. */
const StepText = ({
  output,
  reading,
}: {
  output: Extract<LocalRunStepOutputView, { status: "text" }>;
  reading: boolean;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const label = t(TEXT_KIND_LABEL_KEYS[output.kind]);
  if (output.text === "" && !reading) {
    return <Note>{t("chat.toolCall.localOutput.empty")}</Note>;
  }
  const cut = output.storedBytes < output.totalBytes && (
    <Note>
      {t("chat.toolCall.localOutput.cut", {
        kept: formatFileSize(output.storedBytes, format),
        total: formatFileSize(output.totalBytes, format),
      })}
    </Note>
  );
  if (output.kind === "conversation") {
    return (
      <section aria-busy={reading} aria-label={label}>
        <ScrollArea className="max-h-96">
          <ConversationText text={output.text} />
        </ScrollArea>
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
          {output.kind === "diff" ? (
            <DiffText text={output.text} />
          ) : (
            output.text
          )}
        </pre>
      </ScrollArea>
      {cut}
    </section>
  );
};

/**
 * What a coding agent's step produced on the member's computer, as stella
 * stores it with the conversation, read as the row opens: the output, diff
 * or conversation as it arrives, the image the step viewed, or why there is
 * nothing to show.
 */
const LocalRunStepContent = ({
  activeOrganizationId,
  callId,
  name,
  threadId,
  userId,
}: StepContentProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const query = useQuery(
    localRunStepOutputOptions({
      activeOrganizationId,
      userId,
      threadId,
      callId,
    }),
  );
  const view = queryView(query, { isEmpty: () => false });
  useQueryViewError(view, "LocalRunStepContent:query");
  const retry = (
    <Button
      onClick={() => {
        detached(query.refetch(), "local-run-step-content.retry");
      }}
      size="xs"
      variant="ghost"
    >
      {t("common.tryAgain")}
    </Button>
  );
  switch (view.type) {
    case "pending":
      return <Note pending>{t("common.loading")}</Note>;
    case "error":
      return (
        <Note>
          {t("common.loadFailed")}
          {retry}
        </Note>
      );
    case "empty":
      return panic("A step's content read is never empty");
    case "items":
      break;
    default:
      view satisfies never;
      return panic("Unhandled step content view");
  }
  const output = view.items;
  // A read cut off after it began keeps what arrived, but never reads as
  // the whole content.
  const interrupted =
    view.refetchError === undefined ? null : (
      <Note>
        {t("common.loadFailed")}
        {retry}
      </Note>
    );
  switch (output.status) {
    case "unread":
      return interrupted ?? <Note pending>{t("common.loading")}</Note>;
    case "text":
      return (
        <>
          <StepText
            output={output}
            reading={query.fetchStatus === "fetching"}
          />
          {interrupted}
        </>
      );
    case "answered":
      break;
    default:
      output satisfies never;
      return panic("Unhandled step content status");
  }
  const { content } = output;
  switch (content.state) {
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored: {
      const src = getUserFileContentUrl(content.file.url);
      return src === null ? (
        panic("A stored step image names no file")
      ) : (
        <img
          alt={name}
          className="border-border/50 max-h-96 max-w-full rounded-sm border object-contain"
          src={src}
        />
      );
    }
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.arriving:
      // The computer may send it any time: the member can look again
      // without reopening the row.
      return (
        <Note>
          {t("chat.toolCall.localOutput.arriving")}
          {retry}
        </Note>
      );
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notCopied:
      return (
        <Note>
          {t("chat.toolCall.localOutput.notCopied")}
          <CopyToForkButton
            activeOrganizationId={activeOrganizationId}
            threadId={threadId}
            userId={userId}
          />
        </Note>
      );
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notStored:
      return <Note>{t("chat.toolCall.localOutput.notStored")}</Note>;
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.runBudgetReached:
      return <Note>{t("chat.toolCall.localOutput.runBudgetReached")}</Note>;
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.tooLarge:
      return (
        <Note>
          {t("chat.toolCall.localOutput.imageTooLargeToStore", {
            kept: formatFileSize(
              chatLocalRunStepContentCap(content.kind),
              format,
            ),
            total: formatFileSize(content.totalBytes, format),
          })}
        </Note>
      );
    default:
      content satisfies never;
      return panic("Unhandled step content state");
  }
};

/** A tool call as much as tells what it produced: any call of a turn fits. */
type StepOutputPart = {
  id: string;
  name: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

/**
 * What a settled step of a coding agent produced on the member's computer
 * for them to open, or `null`: any other call, or a step still running.
 */
const localRunStepOutputKindOf = ({
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
 * conversation, or the image a step viewed. Nothing for any other call, for
 * a step still running, or outside a thread.
 */
export const LocalRunStepOutputDetails = ({
  activeOrganizationId,
  part,
  threadId,
}: {
  activeOrganizationId: string;
  part: StepOutputPart;
  threadId: string | undefined;
}) => {
  const user = useMaybeAuthenticatedUser();
  const kind = localRunStepOutputKindOf(part);
  if (kind === null || user === null || threadId === undefined) {
    return null;
  }
  const shown =
    kind === "image"
      ? localRunToolView({
          name: part.name,
          input: part.input,
          output: undefined,
        })?.subtitle
      : undefined;
  return (
    <LocalRunStepContent
      activeOrganizationId={activeOrganizationId}
      callId={part.id}
      name={shown?.type === "text" ? shown.text : ""}
      threadId={toSafeId<"chatThread">(threadId)}
      userId={user.id}
    />
  );
};

/**
 * A subagent's conversation for its group to open, or `null` while the
 * subagent has none to show (it is still at work).
 */
export const localRunSubagentConversation = (
  details: Parameters<typeof LocalRunStepOutputDetails>[0],
) =>
  localRunStepOutputKindOf(details.part) === null ? null : (
    <LocalRunStepOutputDetails {...details} />
  );

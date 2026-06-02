import type { AnchorHTMLAttributes, ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ToolUIPart } from "ai";
import {
  CheckIcon,
  HelpCircleIcon,
  LoaderIcon,
  PencilIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import type { PluggableList } from "unified";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import type {
  AskUserInput,
  AskUserOutput,
  ChatAnonRestoration,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { EntityLink } from "@/components/chat/entity-link";
import { rehypeAnonSpans } from "@/components/chat/rehype-anon-spans";

type AskUserPart = ToolUIPart<Pick<ChatUITools, "ask-user">>;

type AskUserCardProps = {
  part: AskUserPart;
  onSubmit: (toolCallId: string, output: AskUserOutput) => void;
  /**
   * Optional re-run callback. When provided, an answered card
   * exposes an "Edit answers" affordance: the user can change
   * their answers and resubmit, which truncates the transcript
   * down to this ask-user call and replays the model from here.
   * `discardsDownstream` flips the submit button label to a
   * warning copy when the edit will drop replies that came after
   * this ask-user turn.
   */
  onEditAndRerun?:
    | ((toolCallId: string, output: AskUserOutput) => void | Promise<void>)
    | undefined;
  discardsDownstream?: boolean | undefined;
  workspaceId?: string | undefined;
  /**
   * Placeholder → original pairs from the assistant message's
   * `data-stella-anon-restorations` parts. Used to paint green
   * pills around restored names inside the question text and
   * option labels — same audit cue the markdown text body shows.
   */
  restorationPairs?: readonly ChatAnonRestoration[] | undefined;
};

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/gu;
const escapeRegex = (value: string) => value.replaceAll(REGEX_SPECIALS, "\\$&");

const EMPTY_RESTORATION_PAIRS: readonly ChatAnonRestoration[] = Object.freeze(
  [],
);

const createAnalysisAnchor = (workspaceId: string | undefined) =>
  function AnalysisAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
    return <EntityLink {...props} workspaceId={workspaceId} />;
  };

const renderAnalysisAnonymizedSpan = (
  props: ComponentProps<"button"> & { ph?: string },
) => <AnonymizedSpan {...props} />;

/**
 * Walk a plain string and wrap every `original` substring in an
 * `<AnonymizedSpan>`. Used for the ask-user question + option
 * labels — the rehype plugin handles the markdown `analysis` body
 * but the questions/options are rendered as plain text nodes, so
 * they need their own pass.
 *
 * `interactive` propagates to `<AnonymizedSpan>`: pass `false`
 * when the call site is already inside another interactive
 * element (option `<button>`) to avoid invalid nested-button
 * markup; the pill renders as a styled `<span>` without tooltip.
 */
const renderAnonPills = (
  text: string,
  pairs: readonly ChatAnonRestoration[],
  options: { interactive?: boolean } = {},
): ReactNode => {
  if (pairs.length === 0 || text.length === 0) {
    return text;
  }
  const sorted = [...pairs].sort(
    (a, b) => b.original.length - a.original.length,
  );
  const lookup = new Map(
    sorted.map((pair) => [pair.original, pair.placeholder]),
  );
  const pattern = new RegExp(
    sorted.map((pair) => escapeRegex(pair.original)).join("|"),
    "gu",
  );
  const nodes: ReactNode[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastEnd) {
      nodes.push(text.slice(lastEnd, match.index));
    }
    const original = match[0];
    nodes.push(
      <AnonymizedSpan
        interactive={options.interactive ?? true}
        key={`${match.index}-${original}`}
        ph={lookup.get(original)}
      >
        {original}
      </AnonymizedSpan>,
    );
    lastEnd = match.index + original.length;
  }
  if (lastEnd < text.length) {
    nodes.push(text.slice(lastEnd));
  }
  return nodes.length === 1 && typeof nodes[0] === "string" ? nodes[0] : nodes;
};

export const AskUserCard = ({
  part,
  onSubmit,
  onEditAndRerun,
  discardsDownstream,
  workspaceId,
  restorationPairs,
}: AskUserCardProps) => {
  const t = useTranslations();
  // Stable empty fallback so useMemo deps don't churn when the
  // caller doesn't pass any pairs.
  const pairs: readonly ChatAnonRestoration[] =
    restorationPairs ?? EMPTY_RESTORATION_PAIRS;
  const analysisComponents = useMemo(
    () => ({
      a: createAnalysisAnchor(workspaceId),
      "stll-anon": renderAnalysisAnonymizedSpan,
    }),
    [workspaceId],
  );
  // Stable rehype-plugins identity so Streamdown's internal memo
  // can short-circuit when nothing actually changed.
  const analysisRehypePlugins = useMemo<PluggableList | undefined>(
    () => (pairs.length > 0 ? [[rehypeAnonSpans, pairs]] : undefined),
    [pairs],
  );
  const answeredOutput = part.state === "output-available" ? part.output : null;
  const isLoading = part.state === "input-streaming";

  // Input is only fully available after input-streaming.
  // During streaming it's a DeepPartial; treat as null.
  const input: AskUserInput | null =
    (part.state !== "input-streaming" ? part.input : null) ?? null;

  const [answers, setAnswers] = useState<Record<number, string>>(() => {
    if (!input) {
      return {};
    }
    const defaults: Record<number, string> = {};
    for (let i = 0; i < input.questions.length; i++) {
      const question = input.questions[i];
      if (question?.default) {
        defaults[i] = question.default;
      }
    }
    return defaults;
  });
  // Seed defaults once the full input arrives (after streaming).
  // The useState initializer only runs on mount, when input may
  // still be null.
  useEffect(() => {
    if (!input) {
      return;
    }
    setAnswers((prev) => {
      let seeded: Record<number, string> | null = null;
      for (let i = 0; i < input.questions.length; i++) {
        const question = input.questions[i];
        const def = question?.default;
        if (def && !(i in prev)) {
          seeded ??= { ...prev };
          seeded[i] = def;
        }
      }
      return seeded ?? prev;
    });
  }, [input]);

  const [customMode, setCustomMode] = useState<Record<number, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  // Local "edit mode" lets the user flip an answered card back
  // into its input form, pre-filled with the previous answers, so
  // they can amend and re-run from this point. Cancel restores
  // the read-only view. The card never mutates the persisted tool
  // output itself; that's `useChatSession`'s job once submit fires.
  const [isEditing, setIsEditing] = useState(false);
  const canRerun = onEditAndRerun !== undefined;
  const isAnswered = answeredOutput !== null || submitted;
  const isDone = isAnswered && !isEditing;

  const setAnswer = useCallback(
    (idx: number, value: string) =>
      setAnswers((prev) => ({ ...prev, [idx]: value })),
    [],
  );

  const toggleCustom = useCallback(
    (idx: number) =>
      setCustomMode((prev) => ({
        ...prev,
        [idx]: !prev[idx],
      })),
    [],
  );

  const buildOutput = useCallback((): AskUserOutput | null => {
    if (!input) {
      return null;
    }
    return {
      answers: input.questions.map((q, i) => ({
        question: q.question,
        answer: answers[i] ?? "",
      })),
    };
  }, [input, answers]);

  const handleSubmit = useCallback(() => {
    if (!input || submitted) {
      return;
    }
    const output = buildOutput();
    if (!output) {
      return;
    }
    setSubmitted(true);
    onSubmit(part.toolCallId, output);
  }, [input, submitted, buildOutput, onSubmit, part.toolCallId]);

  const handleStartEdit = useCallback(() => {
    if (!input || !answeredOutput || !canRerun) {
      return;
    }
    const seeded: Record<number, string> = {};
    for (let i = 0; i < input.questions.length; i++) {
      const previous = answeredOutput.answers[i]?.answer;
      if (previous !== undefined) {
        seeded[i] = previous;
      } else {
        const def = input.questions[i]?.default;
        if (def) {
          seeded[i] = def;
        }
      }
    }
    setAnswers(seeded);
    // Reset custom-vs-options mode based on whether the previous
    // answer matches one of the offered options; if it doesn't,
    // flip the question into free-text so the prior text stays
    // visible and editable.
    const nextCustom: Record<number, boolean> = {};
    for (let i = 0; i < input.questions.length; i++) {
      const question = input.questions[i];
      const previous = answeredOutput.answers[i]?.answer;
      if (
        question?.options &&
        previous &&
        !question.options.includes(previous)
      ) {
        nextCustom[i] = true;
      }
    }
    setCustomMode(nextCustom);
    setIsEditing(true);
  }, [input, answeredOutput, canRerun]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setCustomMode({});
  }, []);

  const handleRerun = useCallback(() => {
    if (!input || !onEditAndRerun) {
      return;
    }
    const output = buildOutput();
    if (!output) {
      return;
    }
    setIsEditing(false);
    void onEditAndRerun(part.toolCallId, output);
  }, [input, onEditAndRerun, buildOutput, part.toolCallId]);

  if (!input) {
    return (
      <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="font-medium">{t("chat.tool.ask-user")}</span>
          {isLoading && (
            <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        isDone ? "bg-muted/40 border-transparent" : "border-border bg-muted/30",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">{t("chat.tool.ask-user")}</span>
        {isDone && (
          <CheckIcon className="text-success ms-auto size-3.5 shrink-0" />
        )}
        {isDone && canRerun && answeredOutput !== null && (
          <button
            aria-label={t("chat.askUser.edit")}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            onClick={handleStartEdit}
            type="button"
          >
            <PencilIcon className="size-3" />
            {t("chat.askUser.edit")}
          </button>
        )}
      </div>

      {/* Analysis */}
      {input.analysis && (
        <div className="border-border/50 text-muted-foreground border-t px-3 py-2 text-xs [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {analysisRehypePlugins ? (
            <Streamdown
              allowedTags={{ "stll-anon": ["ph"] }}
              components={analysisComponents}
              rehypePlugins={analysisRehypePlugins}
            >
              {input.analysis}
            </Streamdown>
          ) : (
            <Streamdown
              allowedTags={{ "stll-anon": ["ph"] }}
              components={analysisComponents}
            >
              {input.analysis}
            </Streamdown>
          )}
        </div>
      )}

      {/* Questions */}
      <div className="border-border/50 space-y-3 border-t px-3 py-3">
        {input.questions.map((q, i) => {
          const hasOptions = q.options !== undefined && q.options.length > 0;
          return (
            <div className="space-y-1.5" key={q.question}>
              <p className="text-xs font-medium">
                {i + 1}. {renderAnonPills(q.question, pairs)}
              </p>

              {!isDone && hasOptions && !customMode[i] && (
                <div className="flex flex-wrap gap-1.5">
                  {q.options?.map((opt) => (
                    <button
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs",
                        "transition-colors",
                        answers[i] === opt
                          ? "border-foreground bg-foreground text-background"
                          : "hover:bg-muted",
                      )}
                      key={opt}
                      onClick={() => setAnswer(i, opt)}
                      type="button"
                    >
                      {renderAnonPills(opt, pairs, { interactive: false })}
                    </button>
                  ))}
                  <button
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
                    onClick={() => toggleCustom(i)}
                    type="button"
                  >
                    <PencilIcon className="size-2.5" />
                    {t("chat.askUser.custom")}
                  </button>
                </div>
              )}

              {!isDone && (!hasOptions || customMode[i]) && (
                <div className="flex gap-1.5">
                  <input
                    className="bg-background focus-visible:ring-ring flex-1 rounded-md border px-2 py-1 text-xs focus-visible:ring-1 focus-visible:outline-none"
                    onChange={(e) => setAnswer(i, e.target.value)}
                    placeholder={q.default ?? t("chat.askUser.placeholder")}
                    type="text"
                    value={answers[i] ?? ""}
                  />
                  {hasOptions && customMode[i] && (
                    <button
                      className="text-muted-foreground hover:text-foreground text-xs"
                      onClick={() => toggleCustom(i)}
                      type="button"
                    >
                      A/B/C
                    </button>
                  )}
                </div>
              )}

              {isDone && (
                <p className="text-muted-foreground text-xs">
                  {renderAnonPills(
                    answeredOutput?.answers[i]?.answer ||
                      answers[i] ||
                      t("chat.askUser.noAnswer"),
                    pairs,
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Submit */}
      {!isDone && !isLoading && (
        <div className="border-border/50 border-t px-3 py-2">
          {isEditing && discardsDownstream && (
            <p className="text-muted-foreground mb-2 text-xs">
              {t("chat.askUser.editWarning")}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              className="bg-foreground text-background focus-visible:ring-ring rounded-md px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-1"
              onClick={isEditing ? handleRerun : handleSubmit}
              type="button"
            >
              {isEditing ? t("chat.askUser.rerun") : t("chat.askUser.submit")}
            </button>
            {isEditing && (
              <button
                className="text-muted-foreground hover:text-foreground text-xs"
                onClick={handleCancelEdit}
                type="button"
              >
                {t("chat.askUser.cancelEdit")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

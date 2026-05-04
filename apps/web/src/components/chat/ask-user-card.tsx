import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { cn } from "@stll/ui/lib/utils";
import type { ToolUIPart } from "ai";
import {
  CheckIcon,
  HelpCircleIcon,
  LoaderIcon,
  PencilIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { useTranslations } from "use-intl";

import type {
  AskUserInput,
  AskUserOutput,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { EntityLink } from "@/components/chat/entity-link";

type AskUserPart = ToolUIPart<Pick<ChatUITools, "ask-user">>;

type AskUserCardProps = {
  part: AskUserPart;
  onSubmit: (toolCallId: string, output: AskUserOutput) => void;
  workspaceId?: string | undefined;
};

export const AskUserCard = ({
  part,
  onSubmit,
  workspaceId,
}: AskUserCardProps) => {
  const t = useTranslations();
  const analysisComponents = useMemo(
    () => ({
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <EntityLink {...props} workspaceId={workspaceId} />
      ),
    }),
    [workspaceId],
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
  const isDone = answeredOutput !== null || submitted;
  const questionControlRefs = useRef<(HTMLElement | null)[]>([]);

  const setAnswer = useCallback(
    (idx: number, value: string) =>
      setAnswers((prev) => ({ ...prev, [idx]: value })),
    [],
  );

  const registerQuestionControl = useCallback(
    (idx: number) => (node: HTMLElement | null) => {
      questionControlRefs.current[idx] = node;
    },
    [],
  );

  const focusQuestion = useCallback((idx: number) => {
    requestAnimationFrame(() => {
      questionControlRefs.current[idx]?.focus();
    });
  }, []);

  const toggleCustom = useCallback(
    (idx: number) =>
      setCustomMode((prev) => ({
        ...prev,
        [idx]: !prev[idx],
      })),
    [],
  );

  const submitAnswers = useCallback(
    (sourceAnswers: Record<number, string>) => {
      if (!input || submitted) {
        return;
      }
      setSubmitted(true);

      const output: AskUserOutput = {
        answers: input.questions.map((q, i) => ({
          question: q.question,
          answer: sourceAnswers[i] ?? "",
        })),
      };

      onSubmit(part.toolCallId, output);
    },
    [input, submitted, onSubmit, part.toolCallId],
  );

  const handleSubmit = useCallback(() => {
    submitAnswers(answers);
  }, [answers, submitAnswers]);

  const advanceFrom = useCallback(
    (idx: number, sourceAnswers: Record<number, string> = answers) => {
      if (!input || submitted) {
        return;
      }

      const nextIdx = idx + 1;
      if (nextIdx < input.questions.length) {
        focusQuestion(nextIdx);
        return;
      }

      submitAnswers(sourceAnswers);
    },
    [answers, focusQuestion, input, submitted, submitAnswers],
  );

  const selectAnswerAndAdvance = useCallback(
    (idx: number, value: string) => {
      const nextAnswers = { ...answers, [idx]: value };
      setAnswers(nextAnswers);
      advanceFrom(idx, nextAnswers);
    },
    [advanceFrom, answers],
  );

  const handleCustomToggle = useCallback(
    (idx: number) => {
      const opening = !customMode[idx];
      toggleCustom(idx);
      if (opening) {
        focusQuestion(idx);
      }
    },
    [customMode, focusQuestion, toggleCustom],
  );

  const handleAnswerKeyDown = useCallback(
    (idx: number, event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) {
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        advanceFrom(idx);
        return;
      }

      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        advanceFrom(idx);
      }
    },
    [advanceFrom],
  );

  const handleSubmitClick = useCallback(() => {
    if (!input || submitted) {
      return;
    }
    handleSubmit();
  }, [handleSubmit, input, submitted]);

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
          <CheckIcon className="ms-auto size-3.5 shrink-0 text-green-600 dark:text-green-400" />
        )}
      </div>

      {/* Analysis */}
      {input.analysis && (
        <div className="border-border/50 text-muted-foreground border-t px-3 py-2 text-xs [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Streamdown components={analysisComponents}>
            {input.analysis}
          </Streamdown>
        </div>
      )}

      {/* Questions */}
      <div className="border-border/50 space-y-3 border-t px-3 py-3">
        {input.questions.map((q, i) => (
          <div className="space-y-1.5" key={q.question}>
            <p className="text-xs font-medium">
              {i + 1}. {q.question}
            </p>

            {!isDone && q.options && !customMode[i] && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt, optionIndex) => (
                  <button
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs",
                      "transition-colors",
                      answers[i] === opt
                        ? "border-foreground bg-foreground text-background"
                        : "hover:bg-muted",
                    )}
                    key={opt}
                    onClick={() => selectAnswerAndAdvance(i, opt)}
                    ref={
                      optionIndex === 0 ? registerQuestionControl(i) : undefined
                    }
                    type="button"
                  >
                    {opt}
                  </button>
                ))}
                <button
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
                  onClick={() => handleCustomToggle(i)}
                  type="button"
                >
                  <PencilIcon className="size-2.5" />
                  {t("chat.askUser.custom")}
                </button>
              </div>
            )}

            {!isDone && (!q.options || customMode[i]) && (
              <div className="flex gap-1.5">
                <input
                  className="bg-background focus-visible:ring-ring flex-1 rounded-md border px-2 py-1 text-xs focus-visible:ring-1 focus-visible:outline-none"
                  onChange={(e) => setAnswer(i, e.target.value)}
                  onKeyDown={(event) => handleAnswerKeyDown(i, event)}
                  placeholder={q.default ?? t("chat.askUser.placeholder")}
                  ref={registerQuestionControl(i)}
                  type="text"
                  value={answers[i] ?? ""}
                />
                {q.options && customMode[i] && (
                  <button
                    className="text-muted-foreground hover:text-foreground text-xs"
                    onClick={() => handleCustomToggle(i)}
                    type="button"
                  >
                    A/B/C
                  </button>
                )}
              </div>
            )}

            {isDone && (
              <p className="text-muted-foreground text-xs">
                {answeredOutput?.answers[i]?.answer ||
                  answers[i] ||
                  t("chat.askUser.noAnswer")}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Submit */}
      {!isDone && !isLoading && (
        <div className="border-border/50 border-t px-3 py-2">
          <button
            className="bg-foreground text-background focus-visible:ring-ring rounded-md px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-1"
            onClick={handleSubmitClick}
            type="button"
          >
            {t("chat.askUser.submit")}
          </button>
        </div>
      )}
    </div>
  );
};

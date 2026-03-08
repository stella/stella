import { useCallback, useState } from "react";
import type { getToolName } from "ai";
import {
  CheckIcon,
  HelpCircleIcon,
  LoaderIcon,
  PencilIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import { EntityLink } from "@/components/chat/entity-link";

type ToolPart = Parameters<typeof getToolName>[0];

type QuestionInput = {
  question: string;
  reason: string;
  options?: string[];
  default?: string;
};

type AskUserInput = {
  analysis: string;
  questions: QuestionInput[];
};

type AskUserCardProps = {
  part: ToolPart;
  onSubmit: (text: string) => void;
};

const ANALYSIS_COMPONENTS = { a: EntityLink };

export const AskUserCard = ({ part, onSubmit }: AskUserCardProps) => {
  const t = useTranslations();
  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const isDone = part.state === "output-available";

  const input = "input" in part ? (part.input as AskUserInput) : null;

  const [answers, setAnswers] = useState<Record<number, string>>(() => {
    if (!input) {
      return {};
    }
    const defaults: Record<number, string> = {};
    for (let i = 0; i < input.questions.length; i++) {
      const def = input.questions[i].default;
      if (def) {
        defaults[i] = def;
      }
    }
    return defaults;
  });
  const [customMode, setCustomMode] = useState<Record<number, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

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

  const handleSubmit = useCallback(() => {
    if (!input || submitted) {
      return;
    }
    setSubmitted(true);

    const lines = input.questions.map((q, i) => {
      const answer = answers[i] ?? "";
      return `${q.question}: ${answer || "(no answer)"}`;
    });

    onSubmit(lines.join("\n\n"));
  }, [input, answers, submitted, onSubmit]);

  if (!input) {
    return (
      <div className="my-1 rounded-lg border border-border bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <HelpCircleIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{t("chat.tool.askUser")}</span>
          {isLoading && (
            <LoaderIcon className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        isDone || submitted
          ? "border-transparent bg-muted/40"
          : "border-border bg-muted/30",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <HelpCircleIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{t("chat.tool.askUser")}</span>
        {(isDone || submitted) && (
          <CheckIcon className="ml-auto size-3.5 shrink-0 text-green-600 dark:text-green-400" />
        )}
      </div>

      {/* Analysis */}
      {input.analysis && (
        <div className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Streamdown components={ANALYSIS_COMPONENTS}>
            {input.analysis}
          </Streamdown>
        </div>
      )}

      {/* Questions */}
      <div className="space-y-3 border-t border-border/50 px-3 py-3">
        {input.questions.map((q, i) => (
          <div className="space-y-1.5" key={q.question}>
            <p className="text-xs font-medium">
              {i + 1}. {q.question}
            </p>

            {!submitted && q.options && !customMode[i] && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => (
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
                    {opt}
                  </button>
                ))}
                <button
                  className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => toggleCustom(i)}
                  type="button"
                >
                  <PencilIcon className="size-2.5" />
                  {t("chat.askUser.custom")}
                </button>
              </div>
            )}

            {!submitted && (!q.options || customMode[i]) && (
              <div className="flex gap-1.5">
                <input
                  className="flex-1 rounded-md border bg-background px-2 py-1 text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onChange={(e) => setAnswer(i, e.target.value)}
                  placeholder={q.default ?? t("chat.askUser.placeholder")}
                  type="text"
                  value={answers[i] ?? ""}
                />
                {q.options && customMode[i] && (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => toggleCustom(i)}
                    type="button"
                  >
                    A/B/C
                  </button>
                )}
              </div>
            )}

            {submitted && (
              <p className="text-xs text-muted-foreground">
                {answers[i] || "(no answer)"}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Submit */}
      {!submitted && !isLoading && (
        <div className="border-t border-border/50 px-3 py-2">
          <button
            className="rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={handleSubmit}
            type="button"
          >
            {t("chat.askUser.submit")}
          </button>
        </div>
      )}
    </div>
  );
};

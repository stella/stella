import { useCallback, useEffect, useState } from "react";

import type { ToolUIPart } from "ai";
import {
  CheckIcon,
  HelpCircleIcon,
  LoaderIcon,
  PencilIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import type {
  AskUserInput,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { EntityLink } from "@/components/chat/entity-link";

type AskUserPart = ToolUIPart<Pick<ChatUITools, "askUser">>;

type AskUserCardProps = {
  part: AskUserPart;
  onSubmit: (text: string) => void;
};

const ANALYSIS_COMPONENTS = { a: EntityLink };

export const AskUserCard = ({ part, onSubmit }: AskUserCardProps) => {
  const t = useTranslations();
  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const isDone = part.state === "output-available";

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
      const def = input.questions[i].default;
      if (def) {
        defaults[i] = def;
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
        const def = input.questions[i].default;
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
      <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="font-medium">{t("chat.tool.askUser")}</span>
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
        isDone || submitted
          ? "bg-muted/40 border-transparent"
          : "border-border bg-muted/30",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">{t("chat.tool.askUser")}</span>
        {(isDone || submitted) && (
          <CheckIcon className="ms-auto size-3.5 shrink-0 text-green-600 dark:text-green-400" />
        )}
      </div>

      {/* Analysis */}
      {input.analysis && (
        <div className="border-border/50 text-muted-foreground border-t px-3 py-2 text-xs [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Streamdown components={ANALYSIS_COMPONENTS}>
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
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
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
                  className="bg-background focus-visible:ring-ring flex-1 rounded-md border px-2 py-1 text-xs focus-visible:ring-1 focus-visible:outline-none"
                  onChange={(e) => setAnswer(i, e.target.value)}
                  placeholder={q.default ?? t("chat.askUser.placeholder")}
                  type="text"
                  value={answers[i] ?? ""}
                />
                {q.options && customMode[i] && (
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

            {submitted && (
              <p className="text-muted-foreground text-xs">
                {answers[i] || "(no answer)"}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Submit */}
      {!submitted && !isLoading && (
        <div className="border-border/50 border-t px-3 py-2">
          <button
            className="bg-foreground text-background focus-visible:ring-ring rounded-md px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-1"
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

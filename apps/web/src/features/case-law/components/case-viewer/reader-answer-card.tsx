import { useCallback, useRef, useState } from "react";

import { useTranslations } from "use-intl";

import type { ReaderAnnotationVisibility } from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnswer,
  ReaderAnswerCitation,
} from "@stll/api-contract/reader-answers";
import { READER_ANSWER_QUESTION_MAX_LENGTH } from "@stll/api-contract/reader-answers";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

import { CopyActionButton } from "@/components/copy-action-button";
import { useExternalSyncEffect } from "@/hooks/use-effect";

import { AnnotationVisibilityToggle } from "./analysis/annotation-visibility-toggle";
import { readerAnswerErrorCodeKind } from "./reader-answers.logic";
import type { ReaderAnswerFailureKind } from "./reader-answers.logic";

export type ReaderAnswerCardProps = {
  answer: ReaderAnswer;
  onFollowUp: (question: string) => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onVisibility: (visibility: ReaderAnnotationVisibility) => void;
  onCitation: (citation: ReaderAnswerCitation) => void;
  active: boolean;
  openRevision: number;
  citationLabel: (citation: ReaderAnswerCitation) => string;
  onOpen: () => void;
  error?: ReaderAnswerFailureKind | undefined;
  busy: boolean;
};

export const ReaderAnswerCard = ({
  answer,
  onFollowUp,
  onRegenerate,
  onDelete,
  onVisibility,
  onCitation,
  active,
  openRevision,
  citationLabel,
  onOpen,
  error,
  busy,
}: ReaderAnswerCardProps) => {
  const t = useTranslations();
  const [display, setDisplay] = useState<"expanded" | "minimised">("expanded");
  const [question, setQuestion] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [previousOpenRevision, setPreviousOpenRevision] =
    useState(openRevision);
  if (previousOpenRevision !== openRevision) {
    setPreviousOpenRevision(openRevision);
    if (active) {
      setDisplay("expanded");
    }
  }
  const expanded = busy || display === "expanded";
  const observe = useCallback((node: HTMLElement | null) => {
    if (node === null) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) {
        setDisplay("minimised");
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useExternalSyncEffect(() => {
    if (active) {
      composerRef.current?.focus({ preventScroll: true });
    }
  }, [active, openRevision]);
  const open = () => {
    setDisplay("expanded");
    onOpen();
    // Wait for the collapsed content to mount before focusing its composer.
    requestAnimationFrame(() =>
      composerRef.current?.focus({ preventScroll: true }),
    );
  };
  const submit = () => {
    const trimmed = question.trim();
    if (trimmed === "" || busy) {
      return;
    }
    onFollowUp(trimmed);
    setQuestion("");
  };
  const lastAssistant = answer.messages.findLast(
    (message) => message.role === "assistant",
  );
  const failure =
    error ?? readerAnswerErrorCodeKind(lastAssistant?.errorCode ?? null);
  const invalidCitationCount = answer.messages.reduce(
    (count, message) => count + message.invalidCitationCount,
    0,
  );
  const errorMessages = {
    budget: t("readerAnswers.budgetError"),
    model: t("readerAnswers.modelError"),
    network: t("readerAnswers.networkError"),
    timeout: t("readerAnswers.timeoutError"),
  } satisfies Record<NonNullable<ReaderAnswerCardProps["error"]>, string>;
  const errorText = failure === undefined ? undefined : errorMessages[failure];
  return (
    <section
      aria-label={t("readerAnswers.title")}
      aria-busy={busy}
      className="reader-chrome bg-background rounded-md p-2 text-xs shadow-sm"
      data-reader-answer-id={answer.id}
      ref={observe}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-foreground-muted line-clamp-1">
          {answer.anchor.quote}
        </span>
        <Button
          className="min-h-11 shrink-0"
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            if (expanded) {
              setDisplay("minimised");
            } else {
              open();
            }
          }}
          disabled={busy}
          aria-expanded={expanded}
        >
          {expanded ? t("readerAnswers.minimise") : t("readerAnswers.expand")}
        </Button>
      </div>
      {expanded ? (
        <>
          <div aria-live="polite" className="space-y-2">
            {answer.messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  message.role === "user"
                    ? "text-foreground-muted"
                    : "text-foreground",
                )}
              >
                <p className="wrap-break-word whitespace-pre-wrap">
                  {message.content}
                </p>
                {message.status === "streaming" && message.content === "" && (
                  <div role="status" aria-label={t("readerAnswers.loading")}>
                    <Skeleton className="h-12 rounded-sm" />
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {message.citations.map((citation) => (
                    <Button
                      key={`${citation.decisionId}:${citation.paragraphId}`}
                      className="min-h-11 max-w-full break-all"
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => onCitation(citation)}
                    >
                      {citationLabel(citation)}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {errorText && (
            <p role="alert" className="text-destructive mt-2">
              {errorText}
            </p>
          )}
          {invalidCitationCount > 0 && (
            <p className="text-foreground-muted mt-1">
              {t("readerAnswers.invalidCitations", {
                count: invalidCitationCount,
              })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <CopyActionButton
              text={answer.messages
                .map((message) => message.content)
                .join("\n\n")}
              className="min-h-11 min-w-11"
            />
            {answer.mine && (
              <>
                <Button
                  className="min-h-11"
                  disabled={busy}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={onRegenerate}
                >
                  {t("readerAnswers.regenerate")}
                </Button>
                <Button
                  className="min-h-11"
                  disabled={busy}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={onDelete}
                >
                  {t("common.delete")}
                </Button>
                <AnnotationVisibilityToggle
                  shareLabel={t("readerAnswers.share")}
                  visibility={answer.visibility}
                  disabled={busy}
                  onToggle={() =>
                    onVisibility(
                      answer.visibility === "private" ? "shared" : "private",
                    )
                  }
                />
              </>
            )}
          </div>
          {answer.mine && (
            <form
              className="mt-1 flex flex-col gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <Textarea
                ref={composerRef}
                aria-label={t("readerAnswers.followUp")}
                placeholder={t("readerAnswers.followUp")}
                className="min-h-14"
                maxLength={READER_ANSWER_QUESTION_MAX_LENGTH}
                value={question}
                disabled={busy}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) {
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <Button
                className="min-h-11 self-end"
                size="sm"
                type="submit"
                disabled={busy || question.trim() === ""}
              >
                {t("readerAnswers.send")}
              </Button>
            </form>
          )}
        </>
      ) : (
        <button
          className="text-foreground-muted min-h-11 w-full text-start"
          type="button"
          onClick={open}
        >
          {lastAssistant?.content.slice(0, 140) || t("readerAnswers.expand")}
        </button>
      )}
    </section>
  );
};

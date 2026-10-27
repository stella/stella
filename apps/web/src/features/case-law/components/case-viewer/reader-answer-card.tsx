import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
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
import { CitationChip } from "@/components/references/citation-chip";
import { decisionOptions } from "@/features/case-law/queries/decisions";

import { AnnotationVisibilityToggle } from "./analysis/annotation-visibility-toggle";
import type { ReaderAnswerCitationTarget } from "./reader-answer-citation.logic";

type ReaderAnswerCitationChipProps = {
  citation: ReaderAnswerCitation;
  /** The open decision's language, for the paragraph text a chip previews. */
  language: string;
  onCitation: (citation: ReaderAnswerCitation) => void;
  target: ReaderAnswerCitationTarget;
};

/**
 * Fetches a cited decision while its chip is on screen; the workspace observes
 * the same cache entry and redraws the chip once the decision arrives.
 */
const PendingCitedDecisionChip = ({ decisionId }: { decisionId: string }) => {
  useQuery(decisionOptions(decisionId));
  return <Skeleton className="h-4 w-16 rounded-sm" />;
};

/** Both chips follow the citation the way the card always has. */
const ReaderAnswerCitationChip = ({
  citation,
  language,
  onCitation,
  target,
}: ReaderAnswerCitationChipProps) => {
  switch (target.type) {
    case "paragraph":
      return (
        <CitationChip
          kind="paragraph"
          language={language}
          onAnchorClick={() => onCitation(citation)}
          reference={target.reference}
        />
      );
    case "decision":
      return (
        <CitationChip
          kind="decision"
          decision={target.decision}
          onOpen={() => onCitation(citation)}
          paragraphNumber={target.paragraphNumber}
          presentation="inline"
        />
      );
    case "pending":
      return <PendingCitedDecisionChip decisionId={citation.decisionId} />;
    case "unresolved":
      return null;
    default:
      target satisfies never;
      return panic("Unhandled reader answer citation target");
  }
};

export type ReaderAnswerCardProps = {
  answer: ReaderAnswer;
  generationMode: "enabled" | "gated";
  onFollowUp: (question: string) => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onVisibility: (visibility: ReaderAnnotationVisibility) => void;
  onCitation: (citation: ReaderAnswerCitation) => void;
  active: boolean;
  openRevision: number;
  citationTarget: (
    citation: ReaderAnswerCitation,
  ) => ReaderAnswerCitationTarget;
  /** The open decision's language. */
  language: string;
  onOpen: () => void;
  busy: boolean;
};

export const ReaderAnswerCard = ({
  answer,
  generationMode,
  onFollowUp,
  onRegenerate,
  onDelete,
  onVisibility,
  onCitation,
  active,
  openRevision,
  citationTarget,
  language,
  onOpen,
  busy,
}: ReaderAnswerCardProps) => {
  const t = useTranslations();
  const [display, setDisplay] = useState<"expanded" | "minimised">("expanded");
  const [question, setQuestion] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const observerRef = useRef<IntersectionObserver>(null);
  const revealedRevision = useRef<number | null>(null);
  const visibility = useRef<
    "awaiting-reveal" | "awaiting-visible" | "tracking"
  >("tracking");
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
    cardRef.current = node;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && visibility.current !== "awaiting-reveal") {
          visibility.current = "tracking";
        } else if (visibility.current === "tracking") {
          setDisplay("minimised");
        }
      }
    });
    observerRef.current = observer;
    observer.observe(node);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      cardRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      visibility.current = "tracking";
      revealedRevision.current = null;
      return undefined;
    }
    if (revealedRevision.current === openRevision) {
      return undefined;
    }
    // Ignore the observer's pre-scroll sample until the revealed card is seen.
    visibility.current = "awaiting-reveal";
    // Card expansion and the gutter's measured placement commit before this frame.
    const frame = requestAnimationFrame(() => {
      revealedRevision.current = openRevision;
      const node = cardRef.current;
      if (node === null) {
        return;
      }
      node.scrollIntoView({ behavior: "instant", block: "nearest" });
      // Reobserve for a fresh post-scroll sample, even if the card was visible.
      observerRef.current?.disconnect();
      observerRef.current?.takeRecords();
      visibility.current = "awaiting-visible";
      observerRef.current?.observe(node);
      composerRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, openRevision]);
  const open = () => {
    setDisplay("expanded");
    onOpen();
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
  const invalidCitationCount = answer.messages.reduce(
    (count, message) => count + message.invalidCitationCount,
    0,
  );
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
          {answer.anchor.spans.map(({ quote }) => quote).join(" ")}
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {message.citations.map((citation) => (
                    <ReaderAnswerCitationChip
                      key={`${citation.decisionId}:${citation.paragraphId}`}
                      citation={citation}
                      language={language}
                      onCitation={onCitation}
                      target={citationTarget(citation)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
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
            {answer.mine && generationMode === "enabled" && (
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
          {answer.mine && generationMode === "enabled" && (
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

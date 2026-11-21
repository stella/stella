import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ReferencePeek } from "@stll/decision-reader/reference-peek";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import type { DecisionCitationRead } from "@/components/chat/chat-decision-citation-metadata.logic";
import { citationNodeText } from "@/components/references/decision-citation-chip.logic";
import { UNDERLINED_CITATION_CLASS_NAME } from "@/components/references/underlined-citation";
import { detached } from "@/lib/detached";

/**
 * How a citation's read is going, for a surface that draws the citation on
 * its own (`renderPassage` off), where a status line is not inside prose.
 */
export const CitationReadFeedback = ({
  read,
}: {
  read: DecisionCitationRead;
}) => {
  const t = useTranslations();
  if (read.type === "source") {
    return null;
  }
  const { view } = read;
  switch (view.type) {
    case "pending":
      return (
        <span className="text-muted-foreground ms-1 text-xs" role="status">
          {t("common.loading")}
        </span>
      );
    case "empty":
      return (
        <span className="text-muted-foreground ms-1 text-xs">
          {t("common.noResults")}
        </span>
      );
    case "items":
      if (view.refetchError === undefined) {
        return null;
      }
      break;
    case "error":
      break;
    default:
      view satisfies never;
      return panic("Unhandled citation read feedback");
  }
  return (
    <span className="text-destructive ms-1 text-xs" role="alert">
      {t("common.somethingWentWrong")}
      <Button
        size="xs"
        variant="ghost"
        onClick={() => detached(view.retry(), "chat-decision-citation.retry")}
      >
        {t("common.retry")}
      </Button>
    </span>
  );
};

/**
 * An inline citation whose decision has not been read: the answer's own
 * words, as written, and nothing else in the line. An answer is read as
 * prose, so no status, error or retry copy is ever spliced into it. While
 * the read runs the words simply stand; when it fails or finds nothing they
 * are quietly marked, and the peek they open says why, offers a retry, and
 * still opens the decision beside the text, which needs only its id. The
 * failed read itself is reported where every query failure is (the query
 * cache), not here.
 */
export const UnreadInlineCitation = ({
  onOpen,
  originalUrl,
  passage,
  read,
}: {
  onOpen: () => void;
  originalUrl: string | null | undefined;
  passage: ReactNode;
  read: DecisionCitationRead;
}): ReactNode => {
  const t = useTranslations();
  if (read.type === "source") {
    return passage;
  }
  const { view } = read;
  const header = { primary: citationNodeText(passage), meta: [] };
  const trigger = {
    type: "text",
    element: (
      <span
        className={cn(
          UNDERLINED_CITATION_CLASS_NAME,
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        )}
        data-citation-unread={view.type}
      />
    ),
  } as const;
  switch (view.type) {
    case "pending":
    case "items":
      return passage;
    case "empty":
      return (
        <ReferencePeek
          body={
            <span className="text-muted-foreground text-xs">
              {t("caseLaw.citation.notInStella")}
            </span>
          }
          header={header}
          target={{ kind: "unresolvedCitation", actions: {} }}
          trigger={trigger}
        >
          {passage}
        </ReferencePeek>
      );
    case "error":
      return (
        <ReferencePeek
          body={
            <span className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground" role="status">
                {t("common.somethingWentWrong")}
              </span>
              <Button
                onClick={() =>
                  detached(view.retry(), "chat-decision-citation.retry")
                }
                size="xs"
                variant="outline"
              >
                {t("common.retry")}
              </Button>
            </span>
          }
          header={header}
          target={{
            kind: "decision",
            actions: {
              openInSidePanel: onOpen,
              openInStella: null,
              openOriginal: originalUrl ?? null,
            },
          }}
          trigger={trigger}
        >
          {passage}
        </ReferencePeek>
      );
    default:
      view satisfies never;
      return panic("Unhandled unread citation state");
  }
};

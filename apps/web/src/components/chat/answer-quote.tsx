import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { decisionCaseName } from "@stll/decision-reader/decision-text.logic";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { quotePieces } from "@stll/legal-ast/answer-quote";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  AlertTriangleIcon,
  BookTextIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CopyFromMenuIcon,
} from "@stll/ui/icons";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import {
  answerQuoteState,
  quoteTextOf,
} from "@/components/chat/answer-quote.logic";
import type { AnswerQuoteState } from "@/components/chat/answer-quote.logic";
import { openReadCaseLawDecision } from "@/components/chat/case-law-open";
import {
  useAnswerCitedDecisions,
  useAnswerQuoteChecks,
} from "@/components/chat/chat-decision-citation";
import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";
import { CitationCopyOptions } from "@/components/legal-reader/citation-copy-options";
import { quotationMarksFor } from "@/components/legal-reader/citation-copy.logic";
import { decisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import { formatDecisionCitation } from "@/features/case-law/citation-format";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

type VerifiedQuote = Extract<AnswerQuoteState, { type: "verified" }>;

const answerQuoteMarker = (state: AnswerQuoteState): string => {
  switch (state.type) {
    case "verified":
    case "unverified":
      return state.type;
    case "plain":
      return "";
    default:
      state satisfies never;
      return panic("Unhandled answer quote state");
  }
};

const UnverifiedQuoteNote = () => {
  const t = useTranslations();
  return (
    <figcaption className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 ps-3.5 text-xs not-italic">
      <span className="text-warning-foreground inline-flex items-center gap-1 font-medium">
        <AlertTriangleIcon aria-hidden="true" className="size-3.5" />
        {t("chat.answerQuote.unverified")}
      </span>
      <span aria-hidden="true" className="text-foreground-placeholder">
        ·
      </span>
      <span>{t("chat.answerQuote.unverifiedHint")}</span>
    </figcaption>
  );
};

const QuoteAttribution = ({
  quote,
  verified,
}: {
  quote: string;
  verified: VerifiedQuote;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { open } = useOpenDecisionTab();
  const [copyOpen, setCopyOpen] = useState(false);
  const { decision, located } = verified;
  const metadata = decisionCitationMetadata(decision);
  const readerHref = `${metadata.readerUrl}#${encodeURIComponent(located.anchorId)}`;
  const citation = formatDecisionCitation({
    caseNumber: decision.caseNumber,
    caseNumberType: decision.caseNumberType,
    country: decision.country,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType ?? null,
    ecli: decision.ecli ?? null,
    name: decisionCaseName({
      ast: parseDocumentAst(decision.documentAst),
      caseNumber: decision.caseNumber,
    }),
    paragraph: located.paragraph,
    pincite: null,
  });
  const source =
    located.paragraph === null
      ? decision.caseNumber
      : `${decision.caseNumber}, ${t("caseLaw.citation.paragraphMark", {
          paragraph: format.number(located.paragraph),
        })}`;
  // The decision opens beside the answer, at the paragraph the quotation
  // comes from; modifier clicks keep the link's native behaviour.
  const openAtQuote = (event: MouseEvent<HTMLElement>) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    event.preventDefault();
    detached(
      openReadCaseLawDecision(decision, open, { anchorId: located.anchorId }),
      "answer-quote.open",
    );
  };

  return (
    <figcaption className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 ps-3.5 text-xs not-italic">
      <span className="text-success inline-flex items-center gap-1 font-medium">
        <CircleCheckIcon aria-hidden="true" className="size-3.5" />
        {t("chat.answerQuote.verified")}
      </span>
      <span aria-hidden="true" className="text-foreground-placeholder">
        ·
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              className="hover:text-foreground focus-visible:ring-ring rounded-xs underline decoration-dotted underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
              href={sanitizeHref(readerHref)}
              onClick={openAtQuote}
            />
          }
        >
          <BidiText as="span">{source}</BidiText>
        </TooltipTrigger>
        <TooltipPopup>
          {t("chat.answerQuote.verifiedHint", { source: citation })}
        </TooltipPopup>
      </Tooltip>
      <Button
        className="-my-1"
        onClick={openAtQuote}
        render={<a href={sanitizeHref(readerHref)} />}
        size="xs"
        variant="ghost"
      >
        <BookTextIcon aria-hidden="true" className="size-3.5" />
        {t("chat.answerQuote.showInDecision")}
      </Button>
      <Popover onOpenChange={setCopyOpen} open={copyOpen}>
        <PopoverTrigger
          render={<Button className="-my-1" size="xs" variant="ghost" />}
        >
          <CopyFromMenuIcon aria-hidden="true" className="size-3.5" />
          {t("common.copy")}
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </PopoverTrigger>
        <PopoverPanel align="start" className="w-auto">
          <CitationCopyOptions
            citation={citation}
            marks={quotationMarksFor({
              country: decision.country,
              language: decision.language,
            })}
            onCopied={() => {
              setCopyOpen(false);
            }}
            quote={quote}
          />
        </PopoverPanel>
      </Popover>
    </figcaption>
  );
};

const QuoteCaption = ({
  quote,
  state,
}: {
  quote: string;
  state: AnswerQuoteState;
}): ReactNode => {
  switch (state.type) {
    case "verified":
      return (
        <QuoteAttribution
          quote={quotePieces(quote).join(" […] ")}
          verified={state}
        />
      );
    case "unverified":
      return <UnverifiedQuoteNote />;
    case "plain":
      return null;
    default:
      state satisfies never;
      return panic("Unhandled answer quote state");
  }
};

/**
 * A quotation in an answer. Set apart as a callout on a hairline rule, in
 * italics, the way a brief sets quoted authority. When a decision the
 * answer cites holds it word for word, it says so, names the paragraph it
 * comes from, and offers the readers' copy formats with a proper citation.
 * When the decisions it cites were checked and none holds it, it says that.
 */
export const AnswerQuote = ({ children }: { children?: ReactNode }) => {
  const decisions = useAnswerCitedDecisions();
  const checks = useAnswerQuoteChecks();
  const text = quoteTextOf(children);
  const state = answerQuoteState({ quote: text, decisions, checks });

  return (
    <figure className="my-3" data-answer-quote={answerQuoteMarker(state)}>
      <blockquote className="text-foreground-strong-muted border-border border-s-2 ps-3 italic [&>p]:my-1.5">
        {children}
      </blockquote>
      <QuoteCaption quote={text} state={state} />
    </figure>
  );
};

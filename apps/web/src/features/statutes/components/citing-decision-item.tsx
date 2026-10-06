import { useId, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { provisionVersionAsOf } from "@stll/api-contract/provision-version-basis";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { TextMark } from "@stll/ui/text-mark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import { ProvisionVersionBasisLabel } from "@/components/provision-version-basis";
import { CourtName } from "@/features/case-law/components/court-name";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";

import type { CitingDecisionRow } from "./provision-citing-decisions";

/** One citing decision with its count and the passage that applies the provision. */
export const CitingDecisionItem = ({
  currentVersionValidFrom,
  decision,
}: {
  decision: CitingDecisionRow;
  currentVersionValidFrom: string | null;
}) => {
  const t = useTranslations();
  const snippetId = useId();
  const format = useFormatter();
  const [isSnippetExpanded, setIsSnippetExpanded] = useState(false);
  const decided = formatValidityDate(decision.decisionDate, format);
  const versionValidFrom = (() => {
    switch (decision.versionBasis.type) {
      case "inferred":
        return (
          decision.inferredVersionCandidate?.versionValidFrom ??
          decision.versionValidFrom
        );
      case "not_stated":
        return null;
      case "stated_date":
        return (
          decision.versionBasis.expression?.date ??
          (decision.versionBasis.relation === "until"
            ? null
            : decision.versionBasis.date)
        );
      case "stated_version":
        return decision.versionBasis.expression?.date ?? null;
      default: {
        decision.versionBasis satisfies never;
        return panic("Unknown citing-decision version basis");
      }
    }
  })();
  const appliedAsOf =
    versionValidFrom === null
      ? null
      : provisionVersionAsOf(
          {
            versionBasis: decision.versionBasis,
            versionValidFrom,
          },
          decision.decisionDate,
        );
  const citesOlderVersion =
    appliedAsOf !== null &&
    currentVersionValidFrom !== null &&
    appliedAsOf < currentVersionValidFrom;
  const snippet = decision.sentenceText;
  const citation = decision.snippetCitation;
  const citationRange =
    citation !== null &&
    citation.start >= 0 &&
    citation.end > citation.start &&
    citation.end <= (snippet?.length ?? 0)
      ? citation
      : null;

  return (
    <div className="flex flex-col items-start">
      <CitedDecisionLink
        className="hover:bg-accent -mx-2 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 no-underline"
        decision={{
          caseNumber: decision.caseNumber,
          country: decision.country,
          court: decision.court,
          decisionDate: decision.decisionDate,
          id: decision.decisionId,
          language: decision.language,
          languageAlternates: decision.languageAlternates,
          slug: decision.slug,
        }}
      >
        <span className="text-2xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <BidiText as="span" className="text-foreground font-medium">
            {decision.caseNumber}
          </BidiText>
          <CourtName
            abbreviation={decision.courtAbbreviation}
            className="text-muted-foreground"
            court={decision.court}
            tier={decision.courtTier}
          />
          {decided !== null && (
            <BidiText className="text-muted-foreground">{decided}</BidiText>
          )}
          <BidiText className="text-muted-foreground tabular-nums">
            {t("statutes.citingDecisionMentionCount", {
              count: format.number(decision.mentionCount),
            })}
          </BidiText>
        </span>
        {snippet !== null && (
          <BidiText
            as="span"
            className={cn(
              "text-foreground-strong-muted text-2xs leading-snug",
              isSnippetExpanded ? "whitespace-pre-wrap" : "line-clamp-2",
            )}
            id={snippetId}
          >
            {citationRange ? (
              <>
                {snippet.slice(0, citationRange.start)}
                <TextMark variant="fill" tone="muted">
                  {snippet.slice(citationRange.start, citationRange.end)}
                </TextMark>
                {snippet.slice(citationRange.end)}
              </>
            ) : (
              snippet
            )}
          </BidiText>
        )}
      </CitedDecisionLink>
      {citesOlderVersion && (
        <Tooltip>
          <TooltipTrigger render={<Button size="xs" variant="muted" />}>
            {t("statutes.citingDecisionOlderVersion")}
          </TooltipTrigger>
          <TooltipPopup>
            <div className="flex flex-col gap-1">
              <ProvisionVersionBasisLabel basis={decision.versionBasis} />
              <span>
                {formatValidityDate(appliedAsOf, format) ?? appliedAsOf}
              </span>
            </div>
          </TooltipPopup>
        </Tooltip>
      )}
      {snippet !== null && snippet.length > 0 && (
        <Button
          aria-controls={snippetId}
          aria-expanded={isSnippetExpanded}
          onClick={() => setIsSnippetExpanded((expanded) => !expanded)}
          size="sm"
          variant="ghost"
        >
          {isSnippetExpanded
            ? t("statutes.citingDecisionHideSnippet")
            : t("statutes.citingDecisionShowSnippet")}
        </Button>
      )}
    </div>
  );
};

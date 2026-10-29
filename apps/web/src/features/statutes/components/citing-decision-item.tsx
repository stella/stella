import { useId, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { provisionVersionAsOf } from "@stll/api-contract/provision-version-basis";
import { CourtName } from "@stll/decision-reader/court-name";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { TextMark } from "@stll/ui/text-mark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { CitedDecisionChip } from "@/components/legal-reader/cited-decision-link";
import { ProvisionVersionBasisLabel } from "@/components/provision-version-basis";
import { useFormatter } from "@/i18n/formatting-context";
import { formatValidityDate } from "@/lib/statutes/statute-format";

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
          decision.inferredVersionCandidate.versionValidFrom ??
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

  // Four parts, each once: which decision, when and how often, what it says,
  // and the one action on what it says. The case number is the decision's
  // own trigger, so no badge repeats it.
  return (
    <div className="flex min-w-0 flex-col gap-0.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="text-foreground shrink-0 font-medium">
          <CitedDecisionChip
            decision={{
              caseNumber: decision.caseNumber,
              country: decision.country,
              court: decision.court,
              courtAbbreviation: decision.courtAbbreviation,
              sourceUrl: decision.sourceUrl,
              decisionDate: decision.decisionDate,
              id: decision.decisionId,
              language: decision.language,
              languageAlternates: decision.languageAlternates,
              slug: decision.slug,
            }}
            label={<BidiText as="span">{decision.caseNumber}</BidiText>}
            passage={
              snippet === null ? undefined : { type: "text", text: snippet }
            }
          />
        </span>
        <CourtName
          abbreviation={decision.courtAbbreviation}
          className="text-muted-foreground"
          court={decision.court}
          tier={decision.courtTier}
        />
      </div>
      <div className="text-muted-foreground text-2xs flex min-h-5 flex-wrap items-center gap-x-1.5">
        {decided !== null && (
          <>
            <BidiText>{decided}</BidiText>
            <span aria-hidden="true">·</span>
          </>
        )}
        <BidiText className="tabular-nums">
          {t("statutes.citingDecisionMentionCount", {
            count: format.number(decision.mentionCount),
          })}
        </BidiText>
        {citesOlderVersion && (
          <>
            <span aria-hidden="true">·</span>
            {/* A fact about the citation, read like the facts beside it:
                inline text whose dotted rule says there is more on hover. A
                plain button only so a keyboard reaches the tooltip; it does
                nothing itself, hence the plain cursor. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    className="group/plain cursor-default"
                    variant="plain"
                  />
                }
              >
                <span className="text-foreground-strong-muted decoration-foreground-placeholder group-hover/plain:decoration-foreground-muted group-data-popup-open/plain:decoration-foreground-muted relative underline decoration-dotted underline-offset-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-3">
                  {t("statutes.citingDecisionOlderVersion")}
                </span>
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
          </>
        )}
      </div>
      {snippet !== null && snippet.length > 0 && (
        <div className="flex flex-col items-start gap-0.5">
          <BidiText
            as="p"
            className={cn(
              "text-foreground-strong-muted text-2xs m-0 leading-snug",
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
          <Button
            aria-controls={snippetId}
            aria-expanded={isSnippetExpanded}
            className="-ms-2"
            onClick={() => setIsSnippetExpanded((expanded) => !expanded)}
            size="xs"
            variant="muted"
          >
            {isSnippetExpanded
              ? t("statutes.citingDecisionHideSnippet")
              : t("statutes.citingDecisionShowSnippet")}
          </Button>
        </div>
      )}
    </div>
  );
};

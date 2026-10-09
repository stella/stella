import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useFormatter } from "use-intl";

import { CourtName } from "@stll/decision-reader/court-name";
import { DECISION_TITLE_SEPARATOR } from "@stll/decision-reader/decision-identity";
import { BidiText } from "@stll/ui/bidi-text";
import {
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import { formatYear } from "@/features/case-law/citation-format";

import type { LawCrumbTrail } from "./-law-crumb-trail.logic";

export const LawDocumentCrumbs = ({ trail }: { trail: LawCrumbTrail }) => {
  const format = useFormatter();
  switch (trail.kind) {
    case "statute":
      return (
        <>
          {trail.yearLink !== null && (
            <>
              <BreadcrumbSeparator className="max-sm:hidden" />
              <BreadcrumbItem className="max-sm:hidden">
                <Link {...trail.yearLink}>
                  {formatYear(format, trail.yearLink.search.year)}
                </Link>
              </BreadcrumbItem>
            </>
          )}
          <BreadcrumbItem className="sm:hidden">
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0 flex-1">
            <BreadcrumbPage className="min-w-0 flex-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex min-w-0 items-center gap-1.5" />
                  }
                >
                  <DocumentIdentityBadge identity={trail.identity} />
                  {trail.shortTitle !== null && (
                    <BidiText as="span" className="min-w-0 truncate">
                      {trail.shortTitle}
                    </BidiText>
                  )}
                </TooltipTrigger>
                <TooltipPopup>
                  <span>
                    {trail.citation !== null &&
                      !trail.fullTitle.startsWith(trail.citation) && (
                        <>
                          <BidiText>{trail.citation}</BidiText>
                          <br />
                        </>
                      )}
                    <BidiText>{trail.fullTitle}</BidiText>
                  </span>
                </TooltipPopup>
              </Tooltip>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </>
      );
    case "decision":
      return (
        <>
          <BreadcrumbSeparator className="max-sm:hidden" />
          <BreadcrumbItem className="min-w-0 max-sm:hidden">
            <Link {...trail.court.link} className="min-w-0">
              <CourtName
                court={trail.court.name}
                abbreviation={trail.court.abbreviation}
                tier={trail.court.tier}
              />
            </Link>
          </BreadcrumbItem>
          {trail.yearLink !== null && (
            <>
              <BreadcrumbSeparator className="max-sm:hidden" />
              <BreadcrumbItem className="max-sm:hidden">
                <Link {...trail.yearLink}>
                  {formatYear(format, trail.yearLink.search.year)}
                </Link>
              </BreadcrumbItem>
            </>
          )}
          <BreadcrumbItem className="sm:hidden">
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0 flex-1">
            <BreadcrumbPage className="min-w-0">
              <BidiText as="span" className="block truncate">
                {trail.caseNumber}
              </BidiText>
            </BreadcrumbPage>
            {trail.legalArea !== null && (
              <span className="text-muted-foreground min-w-0 truncate">
                {DECISION_TITLE_SEPARATOR} {trail.legalArea}
              </span>
            )}
          </BreadcrumbItem>
        </>
      );
    default:
      trail satisfies never;
      return panic("Unhandled law breadcrumb trail");
  }
};

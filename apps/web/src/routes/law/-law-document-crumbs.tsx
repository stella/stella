import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { CourtName } from "@stll/decision-reader/court-name";
import { DECISION_TITLE_SEPARATOR } from "@stll/decision-reader/decision-title";
import { BidiText } from "@stll/ui/bidi-text";
import {
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { formatYear } from "@/features/case-law/citation-format";
import { StatuteStatusDot } from "@/features/statutes/components/statute-validity-indicator";
import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";

import { CaseFileSwitcher } from "./-components/public-decision-case-file";
import type { LawCrumbTrail } from "./-law-crumb-trail.logic";

/*
 * The trail folds by the width of its bar (the `law-crumbs` container the
 * shell's breadcrumb declares), not the window's: a reader beside an open
 * inspector has a narrow bar on a wide screen. Above the document, crumbs
 * keep their width and fold away whole into the ellipsis; only the
 * document's own crumb (and a court's long name) shrinks, and it truncates,
 * so no crumb is ever drawn over its neighbour. The fold and the ellipsis
 * standing in for it live here together, so they cannot disagree about the
 * width.
 */

/** Folds a crumb above the document while the bar has no room for it. */
const LAW_CRUMB_FOLD_CLASS = "@max-lg/law-crumbs:hidden";
/** A crumb above the document: its full width, or not drawn at all. */
const LAW_ANCESTOR_CRUMB_CLASS = "shrink-0 @max-lg/law-crumbs:hidden";
/** The ellipsis standing in for the folded crumbs. */
const LAW_FOLDED_CRUMBS_CLASS = "shrink-0 @lg/law-crumbs:hidden";

/**
 * A section crumb (the database, a corpus) with the chevron before it when
 * it is not the first. Above a document it folds into the ellipsis while the
 * bar is narrow; without one it is the whole trail and stays.
 */
export const LawSectionCrumb = ({
  aboveDocument,
  children,
  first = false,
}: {
  aboveDocument: boolean;
  children: ReactNode;
  first?: boolean;
}) => (
  <>
    {!first && (
      <BreadcrumbSeparator
        className={cn("shrink-0", aboveDocument && LAW_CRUMB_FOLD_CLASS)}
      />
    )}
    <BreadcrumbItem
      className={cn("shrink-0", aboveDocument && LAW_CRUMB_FOLD_CLASS)}
    >
      {children}
    </BreadcrumbItem>
  </>
);

export const LawDocumentCrumbs = ({ trail }: { trail: LawCrumbTrail }) => {
  const format = useFormatter();
  const t = useTranslations();
  switch (trail.kind) {
    case "statute": {
      const displayStatus = resolveStatuteDisplayStatus(trail);
      const ineligibleLabel = ineligibleExpressionLabelKey(trail.expression);
      const statusLabelKey =
        ineligibleLabel ??
        (displayStatus === null
          ? null
          : STATUTE_STATUS_LABEL_KEYS[displayStatus]);
      const statusLabel =
        statusLabelKey === null ? trail.status : t(statusLabelKey);
      return (
        <>
          {trail.yearLink !== null && (
            <>
              <BreadcrumbSeparator className={LAW_ANCESTOR_CRUMB_CLASS} />
              <BreadcrumbItem className={LAW_ANCESTOR_CRUMB_CLASS}>
                <Link {...trail.yearLink.link}>
                  {formatYear(format, trail.yearLink.year)}
                </Link>
              </BreadcrumbItem>
            </>
          )}
          <BreadcrumbItem className={LAW_FOLDED_CRUMBS_CLASS}>
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator className="shrink-0" />
          <BreadcrumbItem className="min-w-0 flex-1">
            <BreadcrumbPage className="min-w-0 flex-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex min-w-0 items-center gap-1.5" />
                  }
                >
                  <span
                    className="shrink-0"
                    role="img"
                    aria-label={statusLabel}
                  >
                    <StatuteStatusDot
                      expression={trail.expression}
                      status={trail.status}
                      validFrom={trail.validFrom}
                    />
                  </span>
                  <DocumentIdentityBadge identity={trail.identity} />
                  {trail.citation !== null && (
                    <BidiText as="span" className="shrink-0 whitespace-normal">
                      {trail.citation}
                    </BidiText>
                  )}
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
                    {/* The status dot's own hover hint: it sits inside this
                        trigger, so it shares this popup instead of opening a
                        second one over it. */}
                    <br />
                    <span className="text-muted-foreground">{statusLabel}</span>
                  </span>
                </TooltipPopup>
              </Tooltip>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </>
      );
    }
    case "decision":
      return (
        <>
          <BreadcrumbSeparator className={LAW_ANCESTOR_CRUMB_CLASS} />
          {/* A court's name can outgrow the bar on its own, so this crumb
              shrinks and truncates the name rather than keeping its width. */}
          <BreadcrumbItem className={cn("min-w-0", LAW_CRUMB_FOLD_CLASS)}>
            <Link {...trail.court.link} className="flex min-w-0">
              <CourtName
                court={trail.court.name}
                abbreviation={trail.court.abbreviation}
                tier={trail.court.tier}
              />
            </Link>
          </BreadcrumbItem>
          {trail.yearLink !== null && (
            <>
              <BreadcrumbSeparator className={LAW_ANCESTOR_CRUMB_CLASS} />
              <BreadcrumbItem className={LAW_ANCESTOR_CRUMB_CLASS}>
                <Link {...trail.yearLink.link}>
                  {formatYear(format, trail.yearLink.year)}
                </Link>
              </BreadcrumbItem>
            </>
          )}
          <BreadcrumbItem className={LAW_FOLDED_CRUMBS_CLASS}>
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator className="shrink-0" />
          <BreadcrumbItem className="min-w-0 flex-1">
            <BreadcrumbPage className="min-w-0">
              <BidiText as="span" className="block truncate">
                {trail.caseNumber}
              </BidiText>
            </BreadcrumbPage>
            {trail.caseFile !== null && (
              <CaseFileSwitcher
                caseFile={trail.caseFile}
                caseNumber={trail.caseNumber}
              />
            )}
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

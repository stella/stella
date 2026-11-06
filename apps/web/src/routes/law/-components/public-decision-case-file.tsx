import { useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ChevronDownIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Tooltip as TooltipRoot,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/tooltip";

import { parseDecisionDate } from "@/features/case-law/citation-format";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { useFormatter } from "@/i18n/formatting-context";
import {
  caseFileNextPageHref,
  isCurrentCaseFileDocument,
} from "@/routes/law/-components/public-decision-case-file.logic";

type CaseFileSwitcherProps = {
  caseFile: PublicCaseLawDecision["caseFile"] & {
    /** The open decision, checked in the list with its translations. */
    current: Pick<PublicCaseLawDecision, "id" | "languageGroupKey">;
  };
  caseNumber: string;
};

/**
 * The caret beside a decision's case number: the other documents filed under
 * that case number, the open one marked, each opening in the reader.
 */
export const CaseFileSwitcher = ({
  caseFile,
  caseNumber,
}: CaseFileSwitcherProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const routeLocation = useRouterState({
    select: ({ location }) => ({
      pathname: location.pathname,
      search: location.searchStr,
      hash: location.hash,
    }),
  });
  const { current, items, nextCursor } = caseFile;
  const label = t("caseLaw.viewer.caseFileDocuments");

  return (
    <Popover>
      <TooltipRoot>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button aria-label={label} size="icon-xs" variant="ghost" />
              }
            />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </TooltipRoot>
      <PopoverPopup align="start" className="w-80" padding="none">
        <nav aria-label={label}>
          <p className="text-muted-foreground border-b px-3 py-2 text-xs">
            {label} · <BidiText>{caseNumber}</BidiText>
          </p>
          <ScrollArea axis="vertical" className="max-h-72">
            <ul className="p-1">
              {items.map((document) => {
                const params = createCaseLawDecisionRouteParams({
                  caseNumber: document.caseNumber,
                  country: document.country,
                  court: document.court,
                  decisionId: document.id,
                  language: document.language,
                  languageAlternates: document.languageAlternates,
                  slug: document.slug,
                });
                const date = parseDecisionDate(document.decisionDate);
                const isCurrent = isCurrentCaseFileDocument(document, current);
                return (
                  <li key={document.id}>
                    <a
                      aria-current={isCurrent ? "page" : undefined}
                      className="hover:bg-accent text-muted-foreground aria-[current=page]:text-foreground flex min-h-11 flex-col justify-center rounded-md px-2 py-1.5 text-sm aria-[current=page]:font-medium sm:min-h-9"
                      href={sanitizeHref(createCaseLawDecisionPath(params))}
                    >
                      <span className="flex items-baseline gap-2">
                        <BidiText className="min-w-0 truncate">
                          {document.decisionType ?? t("common.documents")}
                        </BidiText>
                        {date !== null && (
                          <time
                            className="ms-auto shrink-0 text-xs"
                            dateTime={date.toString()}
                          >
                            {format.dateTime(
                              date.toZonedDateTime("UTC").epochMilliseconds,
                              { dateStyle: "medium", timeZone: "UTC" },
                            )}
                          </time>
                        )}
                      </span>
                      {document.ecli !== null && (
                        <BidiText className="text-muted-foreground truncate text-xs font-normal">
                          {document.ecli}
                        </BidiText>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
          {nextCursor !== null && (
            <a
              className="hover:bg-accent flex min-h-11 items-center border-t px-3 text-sm sm:min-h-9"
              href={sanitizeHref(
                caseFileNextPageHref(routeLocation, nextCursor),
              )}
            >
              {t("common.next")}
            </a>
          )}
        </nav>
      </PopoverPopup>
    </Popover>
  );
};

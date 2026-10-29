import { useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { ScrollArea } from "@stll/ui/scroll-area";

import { parseDecisionDate } from "@/features/case-law/citation-format";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { useFormatter } from "@/i18n/formatting-context";
import {
  caseFileNextPageHref,
  isCurrentCaseFileDocument,
} from "@/routes/law/-components/public-decision-case-file.logic";

export const PublicDecisionCaseFile = ({
  decision,
}: {
  decision: PublicCaseLawDecision;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const routeLocation = useRouterState({
    select: ({ location }) => ({
      pathname: location.pathname,
      search: location.searchStr,
      hash: location.hash,
    }),
  });
  const { items, nextCursor } = decision.caseFile;
  if (items.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={t("caseLaw.viewer.caseFileDocuments")}
      className="border-b px-4 py-2"
    >
      <details open>
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
          {t("caseLaw.viewer.caseFileDocuments")} ·{" "}
          <BidiText>{decision.caseNumber}</BidiText>
        </summary>
        <div className="h-24">
          <ScrollArea axis="vertical">
            <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
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
                const current = isCurrentCaseFileDocument(document, decision);
                return (
                  <li key={document.id}>
                    <a
                      aria-current={current ? "page" : undefined}
                      className="hover:text-foreground text-muted-foreground aria-[current=page]:text-foreground inline-flex min-h-11 items-center gap-2 underline-offset-4 hover:underline aria-[current=page]:font-medium"
                      href={sanitizeHref(createCaseLawDecisionPath(params))}
                    >
                      <BidiText>
                        {document.decisionType ?? t("common.documents")}
                      </BidiText>
                      {date !== null && (
                        <time dateTime={date.toString()}>
                          {format.dateTime(
                            date.toZonedDateTime("UTC").epochMilliseconds,
                            { dateStyle: "medium", timeZone: "UTC" },
                          )}
                        </time>
                      )}
                      {document.ecli !== null && (
                        <BidiText className="text-xs">{document.ecli}</BidiText>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </div>
        {nextCursor !== null && (
          <a
            className="inline-flex min-h-11 items-center text-sm underline"
            href={sanitizeHref(caseFileNextPageHref(routeLocation, nextCursor))}
          >
            {t("common.next")}
          </a>
        )}
      </details>
    </nav>
  );
};

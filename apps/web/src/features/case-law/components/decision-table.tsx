import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";

import { languageLabel } from "@/features/case-law/components/decision-language-select";
import type { PublicDecisionLanguageAlternate } from "@/features/case-law/public-decision";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";
import {
  type CaseLawDecisionRouteParams,
  createCaseLawDecisionRouteParams,
  normalizeCaseLawLanguageSegment,
} from "@/lib/case-law-route";
import { parseDeterministicDate } from "@/lib/deterministic-date";

// Stable keys so loading rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const SKELETON_CELL_KEYS = [
  "caseNumber",
  "court",
  "country",
  "date",
  "type",
] as const;

export const DecisionTable = ({ decisions, isLoading }: DecisionTableProps) => {
  const t = useTranslations();
  const format = useFormatter();

  if (!isLoading && decisions.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t("caseLaw.emptyState")}
      </p>
    );
  }

  return (
    <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border/45 bg-muted/35 border-b">
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("caseLaw.columns.caseNumber")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.court")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.country")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.date")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.type")}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? SKELETON_ROW_KEYS.map((rowKey) => (
                  <tr
                    className="border-border/35 border-b last:border-b-0"
                    key={rowKey}
                  >
                    {SKELETON_CELL_KEYS.map((cellKey) => (
                      <td className="px-4 py-2" key={cellKey}>
                        <Skeleton className="h-4 w-3/5" />
                      </td>
                    ))}
                  </tr>
                ))
              : decisions.map((decision) => (
                  <tr
                    className="border-border/35 hover:bg-muted/30 border-b last:border-b-0"
                    key={decision.id}
                  >
                    <td className="px-4 py-2">
                      <CaseNumberCell decision={decision} />
                    </td>
                    <td className="px-4 py-2">{decision.court}</td>
                    <td className="px-4 py-2">
                      {renderCountryCell(decision.country)}
                    </td>
                    <td className="px-4 py-2">
                      {formatDecisionDate(decision.decisionDate, format)}
                    </td>
                    <td className="px-4 py-2">
                      {decision.decisionType ?? "—"}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export type Decision = {
  id: string;
  caseNumber: string;
  slug?: string | null;
  ecli: string | null;
  court: string;
  country: string;
  /** The version this row stands for: the one that matched, for a search. */
  language: string;
  /** Every language version of the decision; empty for a monolingual one. */
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  decisionDate: Date | string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  headline?: string | null;
  createdAt: Date | string;
};

type DecisionTableProps = {
  decisions: Decision[];
  isLoading: boolean;
};

type IntlFormatter = ReturnType<typeof useFormatter>;

/**
 * A multilingual decision is one row. The case number opens the version the
 * reader is most likely to want (their UI language when it exists, otherwise
 * the version that matched), and the language menu offers every other one.
 */
const CaseNumberCell = ({ decision }: { decision: Decision }) => {
  const t = useTranslations();
  const format = useFormatter();
  const uiLocale = useLocale();
  const { caseNumber, headline, languageAlternates } = decision;
  const preferred = pickPreferredCaseLawLanguageVariant({
    alternates: languageAlternates,
    matchedLanguage: decision.language,
    uiLocale,
  });
  const target =
    preferred === null
      ? {
          caseNumber,
          country: decision.country,
          court: decision.court,
          decisionId: decision.id,
          language: decision.language,
          slug: decision.slug,
        }
      : {
          caseNumber: preferred.caseNumber,
          country: preferred.country,
          court: preferred.court,
          decisionId: preferred.id,
          language: preferred.language,
          slug: preferred.slug,
        };
  const routeParams = createCaseLawDecisionRouteParams({
    ...target,
    languageAlternates,
  });
  const displayLanguage = normalizeCaseLawLanguageSegment(target.language);
  const matchedLanguage = normalizeCaseLawLanguageSegment(decision.language);
  const multilingual = languageAlternates.length > 1;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2">
        <DecisionLink
          className="text-foreground font-medium hover:underline"
          params={routeParams}
        >
          <BidiText>{caseNumber}</BidiText>
        </DecisionLink>
        {multilingual && displayLanguage !== null && (
          <DecisionLanguageMenu
            alternates={languageAlternates}
            displayLanguage={displayLanguage}
          />
        )}
      </div>
      {headline && (
        <p
          className="text-muted-foreground [&_mark]:text-foreground [&_mark]:bg-warning/30 dark:[&_mark]:bg-warning/20 mt-0.5 line-clamp-2 text-xs [&_mark]:font-medium"
          dangerouslySetInnerHTML={{
            // safe-html: server-escaped + <mark>-highlighted by escapeAndHighlight() in the case-law decisions search handler
            __html: headline,
          }}
        />
      )}
      {multilingual &&
        matchedLanguage !== null &&
        matchedLanguage !== displayLanguage && (
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("caseLaw.languages.matchedIn", {
              language: languageLabel(format, matchedLanguage),
            })}
          </p>
        )}
    </div>
  );
};

const DecisionLink = ({
  children,
  className,
  params,
}: {
  children: ReactNode;
  className: string;
  params: CaseLawDecisionRouteParams;
}) =>
  params.language === undefined ? (
    <Link
      className={className}
      params={{
        country: params.country,
        court: params.court,
        slug: params.slug,
      }}
      to="/law/$country/cases/$court/$slug"
    >
      {children}
    </Link>
  ) : (
    <Link
      className={className}
      params={{
        country: params.country,
        court: params.court,
        language: params.language,
        slug: params.slug,
      }}
      to="/law/$country/cases/$court/$language/$slug"
    >
      {children}
    </Link>
  );

const DecisionLanguageMenu = ({
  alternates,
  displayLanguage,
}: {
  alternates: readonly PublicDecisionLanguageAlternate[];
  displayLanguage: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.language")}
        // Visually a quiet tag; the vertical padding extends the hit area
        // without growing the row.
        className="text-muted-foreground hover:text-foreground -my-2 inline-flex items-center gap-1 rounded-sm px-1.5 py-2 text-xs transition-colors"
      >
        <span className="uppercase">{displayLanguage}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">
          {t("caseLaw.languages.count", { count: alternates.length })}
        </span>
      </MenuTrigger>
      <MenuPopup>
        {alternates.map((alternate) => (
          <MenuItem
            key={alternate.id}
            render={
              <DecisionLink
                className="flex w-full items-center"
                params={createCaseLawDecisionRouteParams({
                  caseNumber: alternate.caseNumber,
                  country: alternate.country,
                  court: alternate.court,
                  decisionId: alternate.id,
                  language: alternate.language,
                  languageAlternates: alternates,
                  slug: alternate.slug,
                })}
              />
            }
          >
            {languageLabel(format, alternate.language)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

const renderCountryCell = (country: string) => (
  <span className="bg-muted rounded px-1.5 py-0.5 text-xs">{country}</span>
);

const formatDecisionDate = (
  value: Decision["decisionDate"],
  format: IntlFormatter,
): string => {
  if (value === null) {
    return "—";
  }
  const date = parseDeterministicDate(value);
  if (date === null) {
    return "—";
  }
  return format.dateTime(date, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
};

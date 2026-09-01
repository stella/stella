import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

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

/** One decision as the public list, search and research tables show it. */
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
  /** Every identifier the publisher supplied; search hits carry them, list rows do not. */
  identifiers?: readonly { type: string; value: string }[] | undefined;
  decisionDate: Date | string | null;
  decisionType: string | null;
  sourceUrl?: string | null | undefined;
  /** The search snippet, highlighted, when the row came from a search. */
  headline?: string | null;
  /** The publisher's one-line summary, when the source carries one. */
  headnote: string | null;
  /** Decisions in the corpus that cite this one. */
  citationCount: number;
  createdAt?: Date | string | undefined;
};

type IntlFormatter = ReturnType<typeof useFormatter>;

/**
 * A multilingual decision is one row. The case number opens the version the
 * reader is most likely to want (their UI language when it exists, otherwise
 * the version that matched), and the language menu offers every other one.
 */
export const CaseNumberCell = ({ decision }: { decision: Decision }) => {
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

/** The public decision route as a Link element, on whichever of the two routes the params name. */
export const decisionLinkElement = (
  params: CaseLawDecisionRouteParams,
  className?: string,
  children?: ReactNode,
) =>
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

const DecisionLink = ({
  children,
  className,
  params,
}: {
  children: ReactNode;
  className: string;
  params: CaseLawDecisionRouteParams;
}) => decisionLinkElement(params, className, children);

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
            // A bare Link element: the menu item merges its role, ref and
            // keyboard handlers into it, which a wrapper component would drop.
            render={decisionLinkElement(
              createCaseLawDecisionRouteParams({
                caseNumber: alternate.caseNumber,
                country: alternate.country,
                court: alternate.court,
                decisionId: alternate.id,
                language: alternate.language,
                languageAlternates: alternates,
                slug: alternate.slug,
              }),
            )}
          >
            {languageLabel(format, alternate.language)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

export const CountryPill = ({ country }: { country: string }) => (
  <span className="bg-muted rounded px-1.5 py-0.5 text-xs">{country}</span>
);

export const formatDecisionDate = (
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

/** The year a decision was handed down, for grouping; null when undated. */
export const decisionYear = (
  value: Decision["decisionDate"],
): number | null => {
  if (value === null) {
    return null;
  }
  const date = parseDeterministicDate(value);
  return date === null ? null : date.getUTCFullYear();
};

export const DecisionDateCell = ({ decision }: { decision: Decision }) => {
  const format = useFormatter();
  return formatDecisionDate(decision.decisionDate, format);
};

/**
 * The publisher's own summary of the decision (legal sentence, abstract,
 * keyword chain or area of law), so a row is recognisable before it is
 * opened. Empty when the source supplies none.
 */
export const HeadnoteCell = ({ decision }: { decision: Decision }) => {
  if (decision.headnote === null) {
    return "—";
  }
  return (
    <p className="text-muted-foreground line-clamp-2 text-xs">
      {decision.headnote}
    </p>
  );
};

export const CitedByCell = ({ decision }: { decision: Decision }) => {
  const format = useFormatter();
  return (
    <span className="tabular-nums">
      {decision.citationCount > 0 ? format.number(decision.citationCount) : "—"}
    </span>
  );
};

export const DecisionLanguageCell = ({ decision }: { decision: Decision }) => {
  const format = useFormatter();
  const language = normalizeCaseLawLanguageSegment(decision.language);
  return language === null ? "—" : languageLabel(format, language);
};

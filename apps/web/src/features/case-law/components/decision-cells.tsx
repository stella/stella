import type { ReactNode } from "react";
import { Fragment } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  TEXT_FIELD_TYPE,
  type DecisionHeadnotePreview,
} from "@stll/api-contract/case-law-text-field";
import { BidiText } from "@stll/ui/bidi-text";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import { parseDecisionDate } from "@/features/case-law/citation-format";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import { decisionClampClassName } from "@/features/case-law/decision-columns.logic";
import type {
  DecisionContentMode,
  DecisionIdentityLineField,
} from "@/features/case-law/decision-columns.logic";
import {
  hasHighlight,
  highlightSegments,
} from "@/features/case-law/headnote-highlight.logic";
import type { HighlightSegment } from "@/features/case-law/headnote-highlight.logic";
import type { PublicDecisionLanguageAlternate } from "@/features/case-law/public-decision";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";
import {
  type CaseLawDecisionRouteParams,
  createCaseLawDecisionRouteParams,
  normalizeCaseLawLanguageSegment,
} from "@/lib/case-law-route";

export { decisionYear } from "@/features/case-law/citation-format";

/** What a cell draws for a value the decision does not carry. */
const EMPTY_VALUE = "—";

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
  /** The block the snippet came from, so the reader opens the text at it. */
  anchorId?: string | null | undefined;
  /** The publisher's one-line summary, when the source carries one. */
  headnote: DecisionHeadnotePreview;
  /** Decisions in the corpus that cite this one. */
  citationCount: number;
  createdAt?: Date | string | undefined;
};

type IntlFormatter = ReturnType<typeof useFormatter>;

/** What the row draws: the decision, plus what the rest of the table is showing. */
export type DecisionRenderContext = {
  /**
   * Facts no visible column is carrying, which the case-number cell says
   * itself so the row still places the decision.
   */
  identityLineFields: readonly DecisionIdentityLineField[];
  /** The query's words, so the summary cell can show why the row matched. */
  queryTokens: readonly string[];
  /** Whether a prose cell is clamped to two lines or shown whole. */
  contentMode: DecisionContentMode;
};

/**
 * The version of a multilingual decision the reader is most likely to want:
 * their UI language when it exists, otherwise the version that matched.
 */
const preferredRouteParams = (
  decision: Decision,
  uiLocale: string,
): CaseLawDecisionRouteParams => {
  const preferred = pickPreferredCaseLawLanguageVariant({
    alternates: decision.languageAlternates,
    matchedLanguage: decision.language,
    uiLocale,
  });
  const target =
    preferred === null
      ? {
          caseNumber: decision.caseNumber,
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
  return createCaseLawDecisionRouteParams({
    ...target,
    languageAlternates: decision.languageAlternates,
  });
};

/**
 * The version that actually matched, not the reader's preferred one.
 *
 * A block anchor is version-local: the passage the snippet came from exists in
 * the matched text and its identifier means nothing in a translation, so an
 * anchored link has to stay on the version that produced it. The preferred
 * alternate is still one click away through the language control.
 */
const matchedRouteParams = (decision: Decision): CaseLawDecisionRouteParams =>
  createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

/**
 * Identity, and nothing a column of its own is saying. A multilingual
 * decision is one row: the case number opens the version the reader is most
 * likely to want, and the language menu offers every other one.
 */
export const CaseNumberCell = ({
  context,
  decision,
}: {
  context: DecisionRenderContext;
  decision: Decision;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const uiLocale = useLocale();
  const { caseNumber, languageAlternates } = decision;
  const routeParams = preferredRouteParams(decision, uiLocale);
  const displayLanguage = normalizeCaseLawLanguageSegment(
    routeParams.language ?? decision.language,
  );
  const matchedLanguage = normalizeCaseLawLanguageSegment(decision.language);
  const multilingual = languageAlternates.length > 1;
  const identity = context.identityLineFields
    .map((field) => identityLineValue(field, decision, format))
    .filter((value) => value !== null);

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
      {identity.length > 0 && (
        // One line, always: identity is scanned down the column, and a court
        // name long enough to wrap would set the width of every row.
        <p className="text-muted-foreground mt-0.5 max-w-80 truncate text-xs">
          {identity.join(" · ")}
        </p>
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

/** One fact of the identity line, or null when the decision does not carry it. */
const identityLineValue = (
  field: DecisionIdentityLineField,
  decision: Decision,
  format: IntlFormatter,
): string | null => {
  switch (field) {
    case "court":
      return decision.court;
    case "date": {
      const date = formatDecisionDate(decision.decisionDate, format);
      return date === EMPTY_VALUE ? null : date;
    }
    case "type":
      return decision.decisionType;
    default:
      field satisfies never;
      return panic(`Unhandled identity line field: ${String(field)}`);
  }
};

/**
 * The hook: what the decision holds, and why the query reached it.
 *
 * The publisher's own summary comes first when the source carries one, because
 * it is the decision's point rather than one passage of it — but only while it
 * answers the question asked. A headnote carrying none of the reader's words
 * explains nothing about this result, so the matched passage takes its place
 * and opens the text at the block it came from.
 */
export const SummaryCell = ({
  context,
  decision,
}: {
  context: DecisionRenderContext;
  decision: Decision;
}) => {
  const headnoteSegments = headnotePreviewSegments(
    decision.headnote,
    context.queryTokens,
  );
  const { headline } = decision;
  // With nothing to look for, a headnote is still the better hook; a browse
  // listing and a saved research table both arrive here with no tokens.
  const headnoteAnswers =
    headnoteSegments !== null &&
    (context.queryTokens.length === 0 ||
      hasHighlight(headnoteSegments) ||
      !headline);

  if (headnoteAnswers) {
    return (
      <BidiText
        as="p"
        className={cn(
          SUMMARY_TEXT_CLASS_NAME,
          decisionClampClassName(context.contentMode),
        )}
      >
        {headnoteSegments.map((segment) =>
          segment.match ? (
            <mark className={MARK_CLASS_NAME} key={segment.start}>
              {segment.text}
            </mark>
          ) : (
            <Fragment key={segment.start}>{segment.text}</Fragment>
          ),
        )}
      </BidiText>
    );
  }

  if (!headline) {
    return EMPTY_VALUE;
  }

  const passage = (
    <HighlightedPassage contentMode={context.contentMode} html={headline} />
  );
  const anchorId = decision.anchorId ?? null;
  if (anchorId === null) {
    return passage;
  }
  return decisionLinkElement({
    children: passage,
    className: "block hover:underline",
    hash: anchorId,
    params: matchedRouteParams(decision),
  });
};

/**
 * Enough of a headnote to judge the row; the density control decides how much.
 * Two lines while the reader is scanning a page of them, all of it once they
 * ask to read one.
 */
const SUMMARY_TEXT_CLASS_NAME = "text-muted-foreground text-xs";

/** The same mark the server's own highlighting draws, so one row reads as one thing. */
const MARK_CLASS_NAME =
  "text-foreground bg-warning/30 font-medium dark:bg-warning/20";

/** The headnote split on the query's words, or null when there is no headnote. */
const headnotePreviewSegments = (
  headnote: DecisionHeadnotePreview,
  queryTokens: readonly string[],
): readonly HighlightSegment[] | null => {
  switch (headnote.type) {
    case TEXT_FIELD_TYPE.PRESENT:
      return highlightSegments(headnote.text, queryTokens);
    case TEXT_FIELD_TYPE.ABSENT:
      return null;
    default:
      headnote satisfies never;
      return panic(`Unhandled decision text field: ${String(headnote)}`);
  }
};

/**
 * A server-escaped, `<mark>`-highlighted snippet. The escaping is the API's:
 * see `escapeAndHighlight()` in the case-law decisions search handler.
 */
const HighlightedPassage = ({
  contentMode,
  html,
}: {
  contentMode: DecisionContentMode;
  html: string;
}) => (
  <p
    className={cn(
      SUMMARY_TEXT_CLASS_NAME,
      decisionClampClassName(contentMode),
      "[&_mark]:text-foreground [&_mark]:bg-warning/30 dark:[&_mark]:bg-warning/20 [&_mark]:font-medium",
    )}
    dangerouslySetInnerHTML={{
      // safe-html: server-escaped + <mark>-highlighted by escapeAndHighlight() in the case-law decisions search handler
      __html: html,
    }}
  />
);

type DecisionLinkOptions = {
  params: CaseLawDecisionRouteParams;
  children?: ReactNode;
  className?: string;
  /** A block anchor in the decision text, so the reader lands on the passage. */
  hash?: string;
};

/** The public decision route as a Link element, on whichever of the two routes the params name. */
export const decisionLinkElement = ({
  children,
  className,
  hash,
  params,
}: DecisionLinkOptions) =>
  params.language === undefined ? (
    <Link
      className={className}
      {...(hash === undefined ? {} : { hash })}
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
      {...(hash === undefined ? {} : { hash })}
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
}) => decisionLinkElement({ children, className, params });

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
            render={decisionLinkElement({
              params: createCaseLawDecisionRouteParams({
                caseNumber: alternate.caseNumber,
                country: alternate.country,
                court: alternate.court,
                decisionId: alternate.id,
                language: alternate.language,
                languageAlternates: alternates,
                slug: alternate.slug,
              }),
            })}
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
    return EMPTY_VALUE;
  }
  const date = parseDecisionDate(value);
  if (date === null) {
    return EMPTY_VALUE;
  }
  return format.dateTime(date.toZonedDateTime("UTC").epochMilliseconds, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
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
export const HeadnoteCell = ({
  contentMode,
  decision,
}: {
  contentMode: DecisionContentMode;
  decision: Decision;
}) => {
  switch (decision.headnote.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return EMPTY_VALUE;
    case TEXT_FIELD_TYPE.PRESENT: {
      return (
        <BidiText
          as="p"
          className={cn(
            SUMMARY_TEXT_CLASS_NAME,
            decisionClampClassName(contentMode),
          )}
        >
          {decision.headnote.text}
        </BidiText>
      );
    }
    default: {
      decision.headnote satisfies never;
      return panic(
        `Unhandled decision text field: ${String(decision.headnote)}`,
      );
    }
  }
};

export const CitedByCell = ({ decision }: { decision: Decision }) => {
  const format = useFormatter();
  return (
    <span className="tabular-nums">
      {decision.citationCount > 0
        ? format.number(decision.citationCount)
        : EMPTY_VALUE}
    </span>
  );
};

export const DecisionLanguageCell = ({ decision }: { decision: Decision }) => {
  const format = useFormatter();
  const language = normalizeCaseLawLanguageSegment(decision.language);
  return language === null ? EMPTY_VALUE : languageLabel(format, language);
};

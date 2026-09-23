import type { MouseEvent, ReactNode } from "react";
import { Fragment } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  type CaseLawDecisionRouteParams,
  createCaseLawDecisionRouteParams,
  normalizeCaseLawLanguageSegment,
} from "@stll/api-contract/case-law-decision-route";
import {
  DECISION_HEADNOTE_KEYWORDS,
  decisionHeadnoteText,
  TEXT_FIELD_TYPE,
  type DecisionHeadnotePreview,
  type TextField,
} from "@stll/api-contract/case-law-text-field";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import {
  SEARCH_MARK_CLASS_NAME,
  SEARCH_MARK_DESCENDANT_CLASS_NAME,
} from "@/components/legal-reader/query-marks";
import { HighlightedText } from "@/components/workspaces/table/find-highlight";
import { parseDecisionDate } from "@/features/case-law/citation-format";
import { CourtName } from "@/features/case-law/components/court-name";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import { preferredDecisionTarget } from "@/features/case-law/decision-cell-target.logic";
import { decisionClampClassName } from "@/features/case-law/decision-columns.logic";
import type {
  DecisionColumnId,
  DecisionContentMode,
  DecisionIdentityLineField,
} from "@/features/case-law/decision-columns.logic";
import type { CourtTier } from "@/features/case-law/decision-filter-facets.logic";
import { decisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import {
  hasHighlight,
  highlightSegments,
} from "@/features/case-law/headnote-highlight.logic";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import type { PublicDecisionLanguageAlternate } from "@/features/case-law/public-decision";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";

export { decisionYear } from "@/features/case-law/citation-format";

/** What a cell draws for a value the decision does not carry. */
const EMPTY_VALUE = "—";

/** A cell no search reached: only the reader's find marks its text. */
const NO_QUERY_TOKENS: readonly string[] = [];

/** One decision as the public list, search and research tables show it. */
export type Decision = {
  id: string;
  caseNumber: string;
  slug?: string | null;
  ecli: string | null;
  court: string;
  /**
   * The court's short form, where the surface that built the row carries one;
   * derived by the API, never here. Absent on a row that predates it.
   */
  courtAbbreviation?: string | null | undefined;
  /** Where the court stands, which is how its abbreviation is drawn. */
  courtTier?: CourtTier | undefined;
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
  /**
   * The query as it was typed, carried into whatever the row opens so the
   * decision's own text marks the words the row marks.
   */
  searchQuery: string | undefined;
  /** Whether a prose cell is clamped to two lines or shown whole. */
  contentMode: DecisionContentMode;
  /** The rows whose cut headnote the reader asked to see whole. */
  expandedHeadnoteIds: ReadonlySet<string>;
  /** Ask for the rest of this row's headnote, or go back to the preview. */
  onToggleHeadnote: (decisionId: string) => void;
};

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
  const openDecision = useOpenDecisionTab();
  const { caseNumber, languageAlternates } = decision;
  const target = preferredDecisionTarget(decision, {
    searchQuery: context.searchQuery,
    uiLocale,
  });
  const routeParams = createCaseLawDecisionRouteParams(target);
  const displayLanguage = normalizeCaseLawLanguageSegment(
    routeParams.language ?? decision.language,
  );
  const matchedLanguage = normalizeCaseLawLanguageSegment(decision.language);
  const multilingual = languageAlternates.length > 1;
  const identity = context.identityLineFields
    .map((field) => ({
      field,
      value: identityLineValue(field, decision, format),
    }))
    .filter(({ value }) => value !== null);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2">
        <DecisionLink
          className="text-foreground font-medium hover:underline"
          onClick={openDecision.onLinkClick(target)}
          params={routeParams}
        >
          <BidiText>
            <HighlightedText columnId="caseNumber" text={caseNumber} />
          </BidiText>
        </DecisionLink>
        {multilingual && displayLanguage !== null && (
          <DecisionLanguageMenu
            alternates={languageAlternates}
            displayLanguage={displayLanguage}
            searchQuery={context.searchQuery}
          />
        )}
      </div>
      {identity.length > 0 && (
        // One line, always: identity is scanned down the column, and a court
        // name long enough to wrap would set the width of every row. The
        // mark keeps the wrap-content mode's unfolding off this line.
        <p
          className="text-muted-foreground mt-0.5 flex max-w-80 min-w-0 items-center gap-x-1.5 overflow-hidden text-xs whitespace-nowrap"
          data-one-line=""
        >
          {identity.map(({ field, value }, index) => (
            <Fragment key={field}>
              {index > 0 && <span aria-hidden="true">·</span>}
              {value}
            </Fragment>
          ))}
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
): ReactNode => {
  switch (field) {
    case "court":
      return (
        <CourtName
          abbreviation={decision.courtAbbreviation}
          court={decision.court}
          tier={decision.courtTier}
        />
      );
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
  const openDecision = useOpenDecisionTab();
  const { headline } = decision;
  // Both kinds are judged as one string, because the question here is whether
  // what the publisher supplied is about the search at all.
  const summaryText = decisionHeadnoteText(decision.headnote);

  if (summaryText.length > 0) {
    // With nothing to look for, a headnote is still the better hook; a browse
    // listing and a saved research table both arrive here with no tokens.
    const answersTheQuery =
      context.queryTokens.length === 0 ||
      hasHighlight(highlightSegments(summaryText, context.queryTokens)) ||
      !headline;
    if (answersTheQuery) {
      return (
        <HeadnotePreviewCell
          columnId="summary"
          context={context}
          decision={decision}
          queryTokens={context.queryTokens}
        />
      );
    }
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
  // The version that matched, not the reader's preferred one: a block anchor
  // is version-local, so its identifier means nothing in a translation. The
  // preferred alternate stays one click away through the language control.
  const target = decisionTabTarget(decision, {
    anchorId,
    searchQuery: context.searchQuery,
  });
  return decisionLinkElement({
    children: passage,
    className: "block hover:underline",
    hash: anchorId,
    onClick: openDecision.onLinkClick(target),
    params: createCaseLawDecisionRouteParams(target),
  });
};

/**
 * Enough of a headnote to judge the row; the density control decides how much.
 * Two lines while the reader is scanning a page of them, all of it once they
 * ask to read one.
 */
const SUMMARY_TEXT_CLASS_NAME = "text-foreground text-sm";

/** The bounded text a row carries, where the source published one. */
type PresentHeadnote = Extract<
  DecisionHeadnotePreview,
  { type: typeof TEXT_FIELD_TYPE.PRESENT }
>;

type HeadnotePreviewCellProps = {
  columnId: DecisionColumnId;
  context: DecisionRenderContext;
  decision: Decision;
  /** The search's words, marked inside whatever the publisher supplied. */
  queryTokens: readonly string[];
};

/**
 * What the publisher supplied, drawn as the kind it is: their sentence as
 * prose, their filing terms as tags. One switch, so a third kind cannot reach
 * a cell without a decision about how it looks.
 */
const HeadnotePreviewCell = ({
  columnId,
  context,
  decision,
  queryTokens,
}: HeadnotePreviewCellProps) => {
  const { headnote } = decision;
  switch (headnote.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return EMPTY_VALUE;
    case DECISION_HEADNOTE_KEYWORDS:
      return (
        <DecisionKeywords
          columnId={columnId}
          items={headnote.items}
          omitted={headnote.omitted}
          queryTokens={queryTokens}
        />
      );
    case TEXT_FIELD_TYPE.PRESENT:
      return (
        <DecisionHeadnote
          columnId={columnId}
          context={context}
          decision={decision}
          headnote={headnote}
          queryTokens={queryTokens}
        />
      );
    default:
      headnote satisfies never;
      return panic(`Unhandled decision headnote: ${String(headnote)}`);
  }
};

/**
 * The terms a publisher filed the decision under, as terms. A classification
 * set as prose reads like an argument the court never made, so it is drawn the
 * way the rest of the table draws a value from a fixed set: one tag each.
 */
export const DecisionKeywords = ({
  columnId,
  items,
  omitted,
  queryTokens,
}: {
  columnId: DecisionColumnId;
  items: readonly string[];
  /** Terms the row's budget dropped, so a part filing does not read whole. */
  omitted: number;
  queryTokens: readonly string[];
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    // Wrapped rather than cut: the row's height is a floor, and a tag sliced
    // at the edge of the cell says less than the term it was.
    <ul className="flex flex-wrap items-center gap-1">
      {items.map((item) => (
        <li
          // A tag stands in for the headnote, so it reads as loudly as one:
          // same class, so a change to how the hook is set moves both.
          className={cn(
            SUMMARY_TEXT_CLASS_NAME,
            "bg-muted shrink-0 rounded px-1.5 py-0.5",
          )}
          key={item}
        >
          <BidiText as="span">
            <HighlightedProse
              columnId={columnId}
              queryTokens={queryTokens}
              text={item}
            />
          </BidiText>
        </li>
      ))}
      {omitted > 0 && (
        <li className="text-muted-foreground shrink-0 text-xs">
          {t("workspaces.views.calendar.more", {
            count: format.number(omitted),
          })}
        </li>
      )}
    </ul>
  );
};

/**
 * Two highlighters over one string: the search's words, and the reader's find
 * inside the runs the search did not claim.
 */
const HighlightedProse = ({
  columnId,
  queryTokens,
  text,
}: {
  columnId: DecisionColumnId;
  queryTokens: readonly string[];
  text: string;
}) => (
  <>
    {highlightSegments(text, queryTokens).map((segment) =>
      segment.match ? (
        <mark className={SEARCH_MARK_CLASS_NAME} key={segment.start}>
          {segment.text}
        </mark>
      ) : (
        <Fragment key={segment.start}>
          <HighlightedText columnId={columnId} text={segment.text} />
        </Fragment>
      ),
    )}
  </>
);

/** How much of a decision's headnote a row is showing, and why that much. */
export const HEADNOTE_VIEW = {
  COLLAPSED: "collapsed",
  FAILED: "failed",
  LOADING: "loading",
  WHOLE: "whole",
} as const;

export type HeadnoteView =
  | { type: typeof HEADNOTE_VIEW.COLLAPSED }
  | { type: typeof HEADNOTE_VIEW.FAILED }
  | { type: typeof HEADNOTE_VIEW.LOADING }
  | { type: typeof HEADNOTE_VIEW.WHOLE; text: string };

/** What the control offers next, in each state the cell can be in. */
const HEADNOTE_CONTROL_LABEL_KEYS = {
  [HEADNOTE_VIEW.COLLAPSED]: "caseLaw.showWholeHeadnote",
  [HEADNOTE_VIEW.FAILED]: "common.retry",
  [HEADNOTE_VIEW.LOADING]: "common.loading",
  [HEADNOTE_VIEW.WHOLE]: "common.showLess",
} as const satisfies Record<HeadnoteView["type"], TranslationKey>;

type HeadnoteViewOptions = {
  expanded: boolean;
  /** Whether the read for the rest of the line failed. */
  failed: boolean;
  /** The whole line once the read carries it; undefined while it does not. */
  whole: string | undefined;
};

const headnoteView = ({
  expanded,
  failed,
  whole,
}: HeadnoteViewOptions): HeadnoteView => {
  if (!expanded) {
    return { type: HEADNOTE_VIEW.COLLAPSED };
  }
  if (whole !== undefined) {
    return { type: HEADNOTE_VIEW.WHOLE, text: whole };
  }
  return failed
    ? { type: HEADNOTE_VIEW.FAILED }
    : { type: HEADNOTE_VIEW.LOADING };
};

/**
 * The whole line the decision read carries. A re-ingest between the two reads
 * can leave the decision with no publisher summary at all, and the preview is
 * then the whole of what there is to show.
 */
const wholeHeadnoteText = (field: TextField, preview: string): string =>
  field.type === TEXT_FIELD_TYPE.PRESENT ? field.text : preview;

/**
 * The publisher's own sentence in a row.
 *
 * The list caps a headnote at the row budget, so the long ones arrive cut. The
 * rest is one read away — the same read the inspector opens the decision with,
 * so a reader who expands a row and then opens it pays for one — and asking
 * for it is a control at the end of the cell rather than a bare ellipsis
 * nothing can be done with.
 */
const DecisionHeadnote = ({
  columnId,
  context,
  decision,
  headnote,
  queryTokens,
}: {
  columnId: DecisionColumnId;
  context: DecisionRenderContext;
  decision: Decision;
  headnote: PresentHeadnote;
  queryTokens: readonly string[];
}) => {
  const expanded = context.expandedHeadnoteIds.has(decision.id);
  // The decision read, and only the one line of it this cell shows: the
  // inspector fills the same cache entry, so a reader who expands a row and
  // then opens it pays for one read rather than two.
  const whole = useQuery({
    ...decisionOptions(decision.id),
    select: (read) => read.headnote,
    enabled: expanded,
  });
  const view = headnoteView({
    expanded,
    failed: whole.isError,
    whole:
      whole.data === undefined
        ? undefined
        : wholeHeadnoteText(whole.data, headnote.text),
  });

  return (
    <HeadnoteProse
      columnId={columnId}
      contentMode={context.contentMode}
      onActivate={() => {
        if (view.type === HEADNOTE_VIEW.FAILED) {
          detached(whole.refetch(), "case-law.headnote-retry");
          return;
        }
        context.onToggleHeadnote(decision.id);
      }}
      preview={headnote}
      queryTokens={queryTokens}
      view={view}
    />
  );
};

type HeadnoteProseProps = {
  /** The column the reader's find marks these runs under. */
  columnId: DecisionColumnId;
  contentMode: DecisionContentMode;
  onActivate: () => void;
  preview: PresentHeadnote;
  /** The search's words, marked inside the publisher's own sentence. */
  queryTokens: readonly string[];
  view: HeadnoteView;
};

/** The cell itself: the text it is showing, and the way to the rest of it. */
export const HeadnoteProse = ({
  columnId,
  contentMode,
  onActivate,
  preview,
  queryTokens,
  view,
}: HeadnoteProseProps) => {
  const t = useTranslations();
  const showingWhole = view.type === HEADNOTE_VIEW.WHOLE;

  return (
    <div>
      <BidiText
        as="p"
        className={cn(
          SUMMARY_TEXT_CLASS_NAME,
          // The publisher's own line breaks: a headnote written as numbered
          // points reads as one self-contradicting sentence without them. The
          // clamp still counts rendered lines, so a break costs one of the
          // two a compact row shows.
          "whitespace-pre-line",
          // A row the reader opened is read, not scanned: the density control
          // still governs every other row on the page.
          showingWhole ? "" : decisionClampClassName(contentMode),
        )}
      >
        <HighlightedProse
          columnId={columnId}
          queryTokens={queryTokens}
          text={showingWhole ? view.text : preview.text}
        />
      </BidiText>
      {preview.truncated && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          {view.type === HEADNOTE_VIEW.FAILED && (
            <span className="text-muted-foreground">
              {t("errors.actionFailed")}
            </span>
          )}
          <button
            aria-expanded={showingWhole}
            // The vertical padding extends the hit area without growing the row.
            className="text-muted-foreground hover:text-foreground -my-2 rounded-sm py-2 underline underline-offset-2 transition-colors"
            onClick={onActivate}
            type="button"
          >
            {t(HEADNOTE_CONTROL_LABEL_KEYS[view.type])}
          </button>
        </div>
      )}
    </div>
  );
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
      // The grid cell sets `whitespace-nowrap` for the scannable columns, so
      // a passage that does not turn it back off is one long line clipped at
      // the cell's edge, and the clamp below has a single line to count.
      // `wrap-break-word` keeps an unbroken citation inside the cell.
      "wrap-break-word whitespace-normal",
      decisionClampClassName(contentMode),
      SEARCH_MARK_DESCENDANT_CLASS_NAME,
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
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

/** The public decision route as a Link element, on whichever of the two routes the params name. */
export const decisionLinkElement = ({
  children,
  className,
  hash,
  onClick,
  params,
}: DecisionLinkOptions) =>
  params.language === undefined ? (
    <Link
      className={className}
      {...(hash === undefined ? {} : { hash })}
      {...(onClick === undefined ? {} : { onClick })}
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
      {...(onClick === undefined ? {} : { onClick })}
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
  onClick,
  params,
}: {
  children: ReactNode;
  className: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  params: CaseLawDecisionRouteParams;
}) => decisionLinkElement({ children, className, onClick, params });

const DecisionLanguageMenu = ({
  alternates,
  displayLanguage,
  searchQuery,
}: {
  alternates: readonly PublicDecisionLanguageAlternate[];
  displayLanguage: string;
  searchQuery: string | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const openDecision = useOpenDecisionTab();

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.language")}
        // The negative margin keeps the button's own height out of the row:
        // it reads as a quiet tag, not as a control.
        render={<Button className="-my-2" size="xs" variant="muted" />}
      >
        <span className="uppercase">{displayLanguage}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">
          {t("caseLaw.languages.count", { count: alternates.length })}
        </span>
      </MenuTrigger>
      <MenuPopup>
        {alternates.map((alternate) => {
          const target: DecisionTabTarget = {
            caseNumber: alternate.caseNumber,
            country: alternate.country,
            court: alternate.court,
            decisionId: alternate.id,
            language: alternate.language,
            languageAlternates: alternates,
            slug: alternate.slug,
            ...(searchQuery === undefined || searchQuery === ""
              ? {}
              : { searchQuery }),
          };
          return (
            <MenuItem
              key={alternate.id}
              // A bare Link element: the menu item merges its role, ref and
              // keyboard handlers into it, which a wrapper component would drop.
              render={decisionLinkElement({
                onClick: openDecision.onLinkClick(target),
                params: createCaseLawDecisionRouteParams(target),
              })}
            >
              {languageLabel(format, alternate.language)}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
};

export const CountryPill = ({ country }: { country: string }) => (
  <span className="bg-muted rounded px-1.5 py-0.5 text-xs">
    <HighlightedText columnId="country" text={country} />
  </span>
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
  context,
  decision,
}: {
  context: DecisionRenderContext;
  decision: Decision;
}) => (
  <HeadnotePreviewCell
    columnId="headnote"
    context={context}
    decision={decision}
    // This column is what the publisher supplied, not the row's match: only
    // the reader's find marks it, the way every metadata column is marked.
    queryTokens={NO_QUERY_TOKENS}
  />
);

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

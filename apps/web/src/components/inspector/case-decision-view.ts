import type { useNavigate } from "@tanstack/react-router";

import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";

import type {
  GenericTab,
  InspectorTab,
} from "@/components/inspector/inspector-store-types";
import { decisionTitle } from "@/features/case-law/decision-title";

/** Registered inspector view kind for one public case-law decision. */
export const CASE_DECISION_VIEW = "case-law-decision";

/**
 * One decision in an inspector tab. The top-level fields are the decision
 * record's own (the court's display name, the record's country); the public
 * page's URL segments live only under `route`. Kept apart by name so a
 * payload handed on as a decision target can never label a tab with a slug
 * or fold a built route param a second time.
 */
export type CaseDecisionViewPayload = {
  /** A block to scroll to and mark once the text is shown. */
  anchorId?: string | undefined;
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  route: CaseLawDecisionRouteParams;
  /** The words that found the decision, so the reader opens on them marked. */
  searchQuery?: string | undefined;
};

type CaseDecisionTarget = {
  anchorId?: string | undefined;
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  language?: string | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  searchQuery?: string | undefined;
  slug?: string | null | undefined;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isOptionalNonEmptyString = (value: unknown): boolean =>
  value === undefined || isNonEmptyString(value);

const isCaseLawDecisionRouteParams = (
  value: unknown,
): value is CaseLawDecisionRouteParams =>
  typeof value === "object" &&
  value !== null &&
  "country" in value &&
  isNonEmptyString(value.country) &&
  "court" in value &&
  isNonEmptyString(value.court) &&
  "slug" in value &&
  isNonEmptyString(value.slug) &&
  (!("language" in value) || isOptionalNonEmptyString(value.language));

export const isCaseDecisionViewPayload = (
  value: unknown,
): value is CaseDecisionViewPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "caseNumber" in value &&
    isNonEmptyString(value.caseNumber) &&
    "country" in value &&
    isNonEmptyString(value.country) &&
    "court" in value &&
    isNonEmptyString(value.court) &&
    "decisionId" in value &&
    isNonEmptyString(value.decisionId) &&
    "route" in value &&
    isCaseLawDecisionRouteParams(value.route) &&
    (!("anchorId" in value) || isOptionalNonEmptyString(value.anchorId)) &&
    (!("searchQuery" in value) || isOptionalNonEmptyString(value.searchQuery))
  );
};

export const caseDecisionTabId = (decisionId: string): string =>
  `${CASE_DECISION_VIEW}:${decisionId}`;

export type CaseDecisionGenericTab = GenericTab & {
  viewType: typeof CASE_DECISION_VIEW;
  payload: CaseDecisionViewPayload;
};

export const isCaseDecisionGenericTab = (
  tab: InspectorTab,
): tab is CaseDecisionGenericTab =>
  tab.type === "view" &&
  tab.viewType === CASE_DECISION_VIEW &&
  isCaseDecisionViewPayload(tab.payload);

/**
 * Navigate the main view to the decision an inspector tab holds. The
 * payload's route was resolved at tab creation, so this is a pure param
 * mapping onto the two public decision routes. A tab opened at a
 * passage keeps it: the full page lands on the same block, with the same
 * words marked. The terms ride in `?q=`, outside the canonical path the
 * public routes are indexed under.
 */
export const navigateToCaseDecisionMain = async (
  navigate: ReturnType<typeof useNavigate>,
  {
    anchorId,
    route: { country, court, language, slug },
    searchQuery,
  }: CaseDecisionViewPayload,
): Promise<void> => {
  const hash = anchorId === undefined ? {} : { hash: anchorId };
  const search = { q: searchQuery };

  if (language === undefined) {
    await navigate({
      to: "/law/$country/cases/$court/$slug",
      params: { country, court, slug },
      search,
      ...hash,
    });
    return;
  }

  await navigate({
    to: "/law/$country/cases/$court/$language/$slug",
    params: { country, court, language, slug },
    search,
    ...hash,
  });
};

export type CaseDecisionViewTab = {
  type: typeof CASE_DECISION_VIEW;
  id: string;
  label: string;
  payload: CaseDecisionViewPayload;
};

/**
 * One tab per decision. Route identity is resolved once at the click boundary,
 * then survives inspector synchronization as plain structured-clone data.
 */
export const createCaseDecisionViewTab = ({
  anchorId,
  caseNumber,
  country,
  court,
  decisionId,
  language,
  languageAlternates,
  searchQuery,
  slug,
}: CaseDecisionTarget): CaseDecisionViewTab => {
  const route = createCaseLawDecisionRouteParams({
    caseNumber,
    country,
    court,
    decisionId,
    language,
    languageAlternates,
    slug,
  });

  return {
    type: CASE_DECISION_VIEW,
    id: caseDecisionTabId(decisionId),
    label: decisionTitle({ caseNumber, court }),
    payload: {
      caseNumber,
      country,
      court,
      decisionId,
      route,
      ...(anchorId === undefined ? {} : { anchorId }),
      ...(searchQuery === undefined ? {} : { searchQuery }),
    },
  };
};

type CitationClick = Pick<
  MouseEvent,
  "altKey" | "button" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/** True only for an unmodified primary click; every other gesture stays native. */
export const isPlainPrimaryClick = ({
  altKey,
  button,
  ctrlKey,
  metaKey,
  shiftKey,
}: CitationClick): boolean =>
  button === 0 && !altKey && !ctrlKey && !metaKey && !shiftKey;

/** Plain primary clicks stay in context; browser navigation gestures remain native. */
export const opensCitationInInspector = (
  click: CitationClick,
  inspectorAvailable: boolean,
): boolean => inspectorAvailable && isPlainPrimaryClick(click);

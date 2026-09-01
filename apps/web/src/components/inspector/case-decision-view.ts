import type { useNavigate } from "@tanstack/react-router";

import type {
  GenericTab,
  InspectorTab,
} from "@/components/inspector/inspector-store-types";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

/** Registered inspector view kind for one public case-law decision. */
export const CASE_DECISION_VIEW = "case-law-decision";

export type CaseDecisionViewPayload = {
  /** A block to scroll to and flash once the text is shown. */
  anchorId?: string | undefined;
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  language?: string | undefined;
  slug: string;
};

type CaseDecisionTarget = {
  anchorId?: string | undefined;
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  language?: string | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

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
    "slug" in value &&
    isNonEmptyString(value.slug) &&
    (!("language" in value) ||
      value.language === undefined ||
      isNonEmptyString(value.language)) &&
    (!("anchorId" in value) ||
      value.anchorId === undefined ||
      isNonEmptyString(value.anchorId))
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
 * payload's route identity was resolved at tab creation, so this is a
 * pure param mapping onto the two public decision routes.
 */
export const navigateToCaseDecisionMain = async (
  navigate: ReturnType<typeof useNavigate>,
  { country, court, language, slug }: CaseDecisionViewPayload,
): Promise<void> =>
  language === undefined
    ? await navigate({
        to: "/law/$country/cases/$court/$slug",
        params: { country, court, slug },
      })
    : await navigate({
        to: "/law/$country/cases/$court/$language/$slug",
        params: { country, court, language, slug },
      });

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
    label: caseNumber,
    payload: {
      caseNumber,
      country: route.country,
      court: route.court,
      decisionId,
      slug: route.slug,
      ...(route.language === undefined ? {} : { language: route.language }),
      ...(anchorId === undefined ? {} : { anchorId }),
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

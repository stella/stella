import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

/** Registered inspector view kind for one public case-law decision. */
export const CASE_DECISION_VIEW = "case-law-decision";

export type CaseDecisionViewPayload = {
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  language?: string | undefined;
  slug: string;
};

type CaseDecisionTarget = {
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  language?: string | null | undefined;
  languageAlternateCount?: number | null | undefined;
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
      isNonEmptyString(value.language))
  );
};

export const caseDecisionTabId = (decisionId: string): string =>
  `${CASE_DECISION_VIEW}:${decisionId}`;

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
  caseNumber,
  country,
  court,
  decisionId,
  language,
  languageAlternateCount,
  languageAlternates,
  slug,
}: CaseDecisionTarget): CaseDecisionViewTab => {
  const route = createCaseLawDecisionRouteParams({
    caseNumber,
    country,
    court,
    decisionId,
    language,
    languageAlternateCount,
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
    },
  };
};

type CitationClick = Pick<
  MouseEvent,
  "altKey" | "button" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/** Plain primary clicks stay in context; browser navigation gestures remain native. */
export const opensCitationInInspector = (
  { altKey, button, ctrlKey, metaKey, shiftKey }: CitationClick,
  inspectorAvailable: boolean,
): boolean =>
  inspectorAvailable &&
  button === 0 &&
  !altKey &&
  !ctrlKey &&
  !metaKey &&
  !shiftKey;

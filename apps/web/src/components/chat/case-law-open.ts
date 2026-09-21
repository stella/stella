import { panic } from "better-result";

import { stellaToast } from "@stll/ui/toast";

import { publicCaseLawCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import { isPublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { getMessageLocale, getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  type CaseLawDecisionRouteParams,
  decodeCaseLawDecisionRef,
  defaultCaseLawCountryForLocale,
  extractCaseLawDecisionIdFromIdRouteParam,
  isCaseLawDecisionId,
  pickCaseLawDecisionHit,
} from "@/lib/case-law-route";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";

/**
 * How a chat link names a decision: by the id or docket a `#stella-decision=`
 * href carries, or by the route params of the decision page's own URL.
 */
export type CaseLawDecisionLocator =
  | { type: "ref"; ref: string }
  | { type: "route"; params: CaseLawDecisionRouteParams };

type OpenCaseLawDecisionOptions = {
  /** A passage of the decision to open at, rather than its beginning. */
  anchorId?: string | undefined;
};

const CASE_LAW_LINK_SEARCH_LIMIT = 5;

type ResolvedDecision = Omit<DecisionTabTarget, "anchorId" | "searchQuery">;

const toResolvedDecision = ({
  caseNumber,
  country,
  court,
  id,
  language,
  languageAlternates,
  slug,
}: {
  caseNumber: string;
  country: string;
  court: string;
  id: string;
  language?: string | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
}): ResolvedDecision => ({
  caseNumber,
  country,
  court,
  decisionId: id,
  language,
  languageAlternates,
  slug,
});

const readDecisionById = async (
  decisionId: string,
): Promise<ResolvedDecision> => {
  const response = await api.case
    .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
    .get();

  return toResolvedDecision(
    unwrapPublicLawEden(response, "resolvePublicCaseLawDecision"),
  );
};

const resolveByRef = async (
  rawRef: string,
): Promise<ResolvedDecision | null> => {
  const ref = decodeCaseLawDecisionRef(rawRef);
  if (!ref) {
    return null;
  }

  if (isCaseLawDecisionId(ref)) {
    return await readDecisionById(ref);
  }

  const country = defaultCaseLawCountryForLocale(getMessageLocale());
  if (country === null) {
    return null;
  }

  const response = await api.case.decisions.search.post({
    country,
    query: ref,
    limit: CASE_LAW_LINK_SEARCH_LIMIT,
  });

  const data = unwrapPublicLawEden(
    response,
    "searchPublicCaseLawDecisionLinks",
  );

  const hit = pickCaseLawDecisionHit(ref, data.hits);
  return hit === null
    ? null
    : toResolvedDecision({ ...hit, id: hit.decisionId });
};

const resolveByRoute = async ({
  country,
  language,
  slug,
}: CaseLawDecisionRouteParams): Promise<ResolvedDecision | null> => {
  const decisionId = extractCaseLawDecisionIdFromIdRouteParam(slug);
  if (decisionId !== null) {
    return await readDecisionById(decisionId);
  }

  const routeCountry = publicCaseLawCountryFromParam(country);
  if (routeCountry === null) {
    return null;
  }

  const response = await api.case.decisions["by-slug"]({ slug }).get({
    query: {
      country: routeCountry,
      ...(language !== undefined && { language }),
    },
  });

  return toResolvedDecision(
    unwrapPublicLawEden(response, "readPublicCaseLawDecisionBySlug"),
  );
};

const resolveCaseLawDecision = async (
  locator: CaseLawDecisionLocator,
): Promise<ResolvedDecision | null> => {
  switch (locator.type) {
    case "ref":
      return await resolveByRef(locator.ref);
    case "route":
      return await resolveByRoute(locator.params);
    default:
      locator satisfies never;
      return panic(`Unhandled locator: ${String(locator)}`);
  }
};

/**
 * Open the decision a chat link names, beside the chat. `open` is the one
 * action the case-law results use (`useOpenDecisionTab`): an inspector tab
 * where there is an inspector, the decision's own page on a phone.
 */
export const openCaseLawDecision = async (
  locator: CaseLawDecisionLocator,
  open: (target: DecisionTabTarget) => void,
  { anchorId }: OpenCaseLawDecisionOptions = {},
) => {
  try {
    if (!isPublicLawPreviewEnabled()) {
      const t = getTranslator();
      stellaToast.add({
        title: t("common.comingSoon"),
        type: "neutral",
      });
      return;
    }

    const decision = await resolveCaseLawDecision(locator);
    if (!decision) {
      const t = getTranslator();
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    open(anchorId === undefined ? decision : { ...decision, anchorId });
  } catch (error) {
    getAnalytics().captureError(error);
    const t = getTranslator();
    stellaToast.add({
      title: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
  }
};

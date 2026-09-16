import { stellaToast } from "@stll/ui/toast";

import { isPublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { getMessageLocale, getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  createCaseLawDecisionRouteParams,
  decodeCaseLawDecisionRef,
  defaultCaseLawCountryForLocale,
  isCaseLawDecisionId,
  pickCaseLawDecisionHit,
} from "@/lib/case-law-route";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";

type NavigateToCaseLawDecision = (options: {
  /**
   * The block the reader lands on, as the route reads it back: bare, with no
   * leading `#`. The reader marks it and scrolls to it.
   */
  hash?: string;
  params: {
    country: string;
    court: string;
    slug: string;
  };
  to: "/law/$country/cases/$court/$slug";
}) => Promise<void> | void;

type OpenCaseLawDecisionOptions = {
  /** A passage of the decision to open at, rather than its beginning. */
  anchorId?: string | undefined;
};

const CASE_LAW_LINK_SEARCH_LIMIT = 5;

type CaseLawDecisionRouteParams = Parameters<
  typeof createCaseLawDecisionRouteParams
>[0];

const resolveCaseLawDecisionRouteParams = async (
  rawDecisionRef: string,
): Promise<ReturnType<typeof createCaseLawDecisionRouteParams> | null> => {
  const decisionRef = decodeCaseLawDecisionRef(rawDecisionRef);
  if (!decisionRef) {
    return null;
  }

  if (isCaseLawDecisionId(decisionRef)) {
    const response = await api.case
      .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionRef) })
      .get();

    const data = unwrapPublicLawEden(response, "resolvePublicCaseLawDecision");

    return createCaseLawDecisionRouteParams({
      caseNumber: data.caseNumber,
      country: data.country,
      court: data.court,
      decisionId: data.id,
      slug: data.slug,
    });
  }

  const country = defaultCaseLawCountryForLocale(getMessageLocale());
  if (country === null) {
    return null;
  }

  const response = await api.case.decisions.search.post({
    country,
    query: decisionRef,
    limit: CASE_LAW_LINK_SEARCH_LIMIT,
  });

  const data = unwrapPublicLawEden(
    response,
    "searchPublicCaseLawDecisionLinks",
  );

  const hit = pickCaseLawDecisionHit(decisionRef, data.hits);
  if (!hit) {
    return null;
  }

  const routeParams: CaseLawDecisionRouteParams = {
    caseNumber: hit.caseNumber,
    country: hit.country,
    court: hit.court,
    decisionId: hit.decisionId,
    slug: hit.slug,
  };

  return createCaseLawDecisionRouteParams(routeParams);
};

export const openCaseLawDecision = async (
  rawDecisionRef: string,
  navigate: NavigateToCaseLawDecision,
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

    const params = await resolveCaseLawDecisionRouteParams(rawDecisionRef);
    if (!params) {
      const t = getTranslator();
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    await navigate({
      to: "/law/$country/cases/$court/$slug",
      params,
      ...(anchorId === undefined ? {} : { hash: anchorId }),
    });
  } catch (error) {
    getAnalytics().captureError(error);
    const t = getTranslator();
    stellaToast.add({
      title: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
  }
};

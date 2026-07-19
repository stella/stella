import { stellaToast } from "@stll/ui/components/toast";

import { isPublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  createCaseLawDecisionRouteParams,
  decodeCaseLawDecisionRef,
  isCaseLawDecisionId,
  pickCaseLawDecisionHit,
} from "@/lib/case-law-route";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { assertPublicLawApiData } from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";

type NavigateToCaseLawDecision = (options: {
  params: {
    country: string;
    court: string;
    slug: string;
  };
  to: "/law/$country/cases/$court/$slug";
}) => Promise<void> | void;

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

    const data = unwrapEden(response);
    assertPublicLawApiData(data, "resolvePublicCaseLawDecision");

    return createCaseLawDecisionRouteParams({
      caseNumber: data.caseNumber,
      country: data.country,
      court: data.court,
      slug: data.slug,
    });
  }

  const response = await api.case.decisions.search.post({
    query: decisionRef,
    limit: CASE_LAW_LINK_SEARCH_LIMIT,
  });

  const data = unwrapEden(response);
  assertPublicLawApiData(data, "searchPublicCaseLawDecisionLinks");

  const hit = pickCaseLawDecisionHit(decisionRef, data.hits);
  if (!hit) {
    return null;
  }

  const routeParams: CaseLawDecisionRouteParams = {
    caseNumber: hit.caseNumber,
    country: hit.country,
    court: hit.court,
    slug: hit.slug,
  };

  return createCaseLawDecisionRouteParams(routeParams);
};

export const openCaseLawDecision = async (
  rawDecisionRef: string,
  navigate: NavigateToCaseLawDecision,
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

import { stellaToast } from "@stll/ui/components/toast";

import { getTranslator } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import {
  createCaseLawDecisionRouteParams,
  decodeCaseLawDecisionRef,
  isCaseLawDecisionId,
  pickCaseLawDecisionHit,
} from "@/lib/case-law-route";
import { toAPIError } from "@/lib/errors";
import { assertPublicLawApiData } from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";

type NavigateToCaseLawDecision = (options: {
  params: {
    country: string;
    court: string;
    date: string;
    slug: string;
  };
  to: "/law/$country/cases/$court/$date/$slug";
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

    if (response.error) {
      throw toAPIError(response.error);
    }
    const data = response.data;
    assertPublicLawApiData(data, "resolvePublicCaseLawDecision");

    return createCaseLawDecisionRouteParams({
      caseNumber: data.caseNumber,
      country: data.country,
      court: data.court,
      decisionDate: data.decisionDate,
      decisionId: data.id,
      slug: data.slug,
    });
  }

  const response = await api.case.decisions.search.post({
    query: decisionRef,
    limit: CASE_LAW_LINK_SEARCH_LIMIT,
  });

  if (response.error) {
    throw toAPIError(response.error);
  }
  const data = response.data;
  assertPublicLawApiData(data, "searchPublicCaseLawDecisionLinks");

  const hit = pickCaseLawDecisionHit(decisionRef, data.hits);
  if (!hit) {
    return null;
  }

  const routeParams: CaseLawDecisionRouteParams = {
    caseNumber: hit.caseNumber,
    country: hit.country,
    court: hit.court,
    decisionDate: hit.decisionDate,
    decisionId: hit.decisionId,
    slug: hit.slug,
  };

  return createCaseLawDecisionRouteParams(routeParams);
};

export const openCaseLawDecision = async (
  rawDecisionRef: string,
  navigate: NavigateToCaseLawDecision,
) => {
  try {
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
      to: "/law/$country/cases/$court/$date/$slug",
      params,
    });
  } catch (error) {
    const t = getTranslator();
    stellaToast.add({
      title: error instanceof Error ? error.message : t("errors.actionFailed"),
      type: "error",
    });
  }
};

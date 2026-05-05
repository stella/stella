import { stellaToast } from "@stll/ui/components/toast";

import { getTranslator } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import {
  createCaseLawDecisionRouteParam,
  decodeCaseLawDecisionRef,
  isCaseLawDecisionId,
  pickCaseLawDecisionHit,
} from "@/lib/case-law-route";
import { toAPIError } from "@/lib/errors";

type NavigateToCaseLawDecision = (options: {
  params: { decisionId: string };
  to: "/knowledge/case/$decisionId";
}) => Promise<void> | void;

const CASE_LAW_LINK_SEARCH_LIMIT = 5;

const resolveCaseLawDecisionRouteParam = async (
  rawDecisionRef: string,
): Promise<string | null> => {
  const decisionRef = decodeCaseLawDecisionRef(rawDecisionRef);
  if (!decisionRef) {
    return null;
  }

  if (isCaseLawDecisionId(decisionRef)) {
    return decisionRef;
  }

  const response = await api.case.decisions.search.post({
    query: decisionRef,
    limit: CASE_LAW_LINK_SEARCH_LIMIT,
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  const hit = pickCaseLawDecisionHit(decisionRef, response.data.hits);
  if (!hit) {
    return null;
  }

  return createCaseLawDecisionRouteParam({
    caseNumber: hit.caseNumber,
    decisionId: hit.decisionId,
  });
};

export const openCaseLawDecision = async (
  rawDecisionRef: string,
  navigate: NavigateToCaseLawDecision,
) => {
  try {
    const decisionId = await resolveCaseLawDecisionRouteParam(rawDecisionRef);
    if (!decisionId) {
      const t = getTranslator();
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    await navigate({
      to: "/knowledge/case/$decisionId",
      params: { decisionId },
    });
  } catch (error) {
    const t = getTranslator();
    stellaToast.add({
      title: error instanceof Error ? error.message : t("errors.actionFailed"),
      type: "error",
    });
  }
};

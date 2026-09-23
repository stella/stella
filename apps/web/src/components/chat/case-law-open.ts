import { panic } from "better-result";

import {
  DECISION_READ_RESOLUTION,
  type DecisionReadResolution,
} from "@stll/api-contract/case-law-decision-resolution";
import { stellaToast } from "@stll/ui/toast";

import { publicCaseLawCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import { anchorAfterResolution } from "@/features/case-law/decision-resolution.logic";
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

/** A decision a link resolved to, and how its address reached it. */
type Resolution = {
  decision: ResolvedDecision;
  resolution: DecisionReadResolution;
  /** The decision's document, where the read returned one. */
  documentAst: unknown;
};

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

/** A search hit names the decision itself and carries no document. */
const directResolution = (decision: ResolvedDecision): Resolution => ({
  decision,
  resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
  documentAst: null,
});

type DecisionRead = Parameters<typeof toResolvedDecision>[0] & {
  documentAst: unknown;
  resolution: DecisionReadResolution;
};

/** A decision read: the old id or slug of absorbed reasons reads the judgment. */
const fromDecisionRead = (read: DecisionRead): Resolution => ({
  decision: toResolvedDecision(read),
  resolution: read.resolution,
  documentAst: read.documentAst,
});

const readDecisionById = async (decisionId: string): Promise<Resolution> => {
  const response = await api.case
    .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
    .get();

  return fromDecisionRead(
    unwrapPublicLawEden(response, "resolvePublicCaseLawDecision"),
  );
};

const resolveByRef = async (rawRef: string): Promise<Resolution | null> => {
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
    : directResolution(toResolvedDecision({ ...hit, id: hit.decisionId }));
};

const resolveByRoute = async ({
  country,
  language,
  slug,
}: CaseLawDecisionRouteParams): Promise<Resolution | null> => {
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

  return fromDecisionRead(
    unwrapPublicLawEden(response, "readPublicCaseLawDecisionBySlug"),
  );
};

const resolveCaseLawDecision = async (
  locator: CaseLawDecisionLocator,
): Promise<Resolution | null> => {
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

    const resolved = await resolveCaseLawDecision(locator);
    if (!resolved) {
      const t = getTranslator();
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    const { decision } = resolved;
    const target = anchorAfterResolution({ ...resolved, anchorId });
    open(target === undefined ? decision : { ...decision, anchorId: target });
  } catch (error) {
    getAnalytics().captureError(error);
    const t = getTranslator();
    stellaToast.add({
      title: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
  }
};

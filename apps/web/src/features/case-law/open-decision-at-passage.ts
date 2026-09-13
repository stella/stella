import type { useNavigate } from "@tanstack/react-router";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

/**
 * Open a decision at the passage an answer leaned on.
 *
 * Two routes, because a multilingual decision addresses its version in the
 * path; the same branch the decision links themselves take. One module, so the
 * results table and a matter's linked decisions cannot drift into sending a
 * reader to two different places for the same cell.
 */
export const openDecisionAtPassage = async (
  navigate: ReturnType<typeof useNavigate>,
  decision: Decision,
  anchorId: string,
): Promise<void> => {
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });
  if (params.language === undefined) {
    await navigate({
      to: "/law/$country/cases/$court/$slug",
      params: {
        country: params.country,
        court: params.court,
        slug: params.slug,
      },
      hash: anchorId,
    });
    return;
  }
  await navigate({
    to: "/law/$country/cases/$court/$language/$slug",
    params: {
      country: params.country,
      court: params.court,
      language: params.language,
      slug: params.slug,
    },
    hash: anchorId,
  });
};

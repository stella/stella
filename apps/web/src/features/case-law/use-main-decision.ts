import { useMatch } from "@tanstack/react-router";

import type { PublicCaseLawDecision } from "@/routes/law/-case-detail.logic";

/**
 * The decision the main view currently renders, when the active route
 * is one of the public decision pages; `undefined` everywhere else.
 */
export const useMainCaseLawDecision = (): PublicCaseLawDecision | undefined => {
  const canonicalMatch = useMatch({
    from: "/law/$country/cases/$court/$slug",
    shouldThrow: false,
  });
  const languageVariantMatch = useMatch({
    from: "/law/$country/cases/$court/$language/$slug",
    shouldThrow: false,
  });
  return canonicalMatch?.loaderData ?? languageVariantMatch?.loaderData;
};

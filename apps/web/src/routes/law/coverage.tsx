import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { caseLawCoverageOptions } from "@/features/case-law/queries/decisions";
import { getTranslator } from "@/i18n/i18n-store";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  CaseLawCoveragePage,
  CaseLawCoveragePending,
} from "@/routes/law/-law-coverage/coverage-page";

const COVERAGE_PATH = "/law/coverage";

export const Route = createFileRoute("/law/coverage")({
  loader: async ({ context: { queryClient } }) => {
    await ensureRouteQueryData(queryClient, caseLawCoverageOptions());
  },
  head: () => {
    const t = getTranslator();
    const title = pageTitle("caseLaw.coverage.title");
    // The page body already renders this sentence from the catalogue; a
    // second English copy here would serve a French reader an English
    // description and drift from the one the page shows.
    const description = t("caseLaw.coverage.description");

    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        aboutName: "Case-law decisions",
        canonicalUrl: createPublicLawCanonicalUrl(COVERAGE_PATH),
        description,
        kind: "caseLaw",
        name: title,
      }),
      path: COVERAGE_PATH,
      title,
      type: "website",
    });
  },
  component: CaseLawCoverage,
  pendingComponent: CaseLawCoveragePending,
});

function CaseLawCoverage() {
  const { data } = useSuspenseQuery(caseLawCoverageOptions());

  return <CaseLawCoveragePage coverage={data} />;
}

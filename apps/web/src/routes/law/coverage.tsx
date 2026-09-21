import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { caseLawCoverageOptions } from "@/features/case-law/queries/decisions";
import { getTranslator } from "@/i18n/i18n-store";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { fetchRouteQuery } from "@/lib/react-query";
import {
  CaseLawCoveragePage,
  CaseLawCoveragePending,
} from "@/routes/law/-law-coverage/coverage-page";

const COVERAGE_PATH = "/law/coverage";

/** What the page shows when the figures cannot be read at all. */
const UNAVAILABLE = { message: "Coverage is unavailable" } as const;

export const Route = createFileRoute("/law/coverage")({
  loader: ({ context: { queryClient } }) => {
    // Started, not awaited: the figures are read across the whole corpus and
    // can take longer than a route may block for. The page has its own
    // pending shape and fills in when they arrive; a route that failed on
    // their timeout would show an error page for a slow read.
    detached(
      fetchRouteQuery(queryClient, caseLawCoverageOptions()),
      "case-law.coverage-prefetch",
    );
  },
  head: () => {
    const t = getTranslator();
    const title = pageTitle("caseLaw.coverage.title");
    // The head carries the sentence the catalogue holds for the page, so a
    // French reader's description is French and cannot drift from the copy.
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
  const { data, isError } = useQuery(caseLawCoverageOptions());

  if (isError) {
    return <CaseLawCoveragePage coverage={UNAVAILABLE} />;
  }
  if (data === undefined) {
    return <CaseLawCoveragePending />;
  }
  return <CaseLawCoveragePage coverage={data} />;
}

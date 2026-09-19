import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { caseLawCoverageOptions } from "@/features/case-law/queries/decisions";
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

const COVERAGE_DESCRIPTION =
  "How much case law the public corpus holds, per country and per court, and how fresh each source is.";

export const Route = createFileRoute("/law/coverage")({
  loader: async ({ context: { queryClient } }) => {
    await ensureRouteQueryData(queryClient, caseLawCoverageOptions());
  },
  head: () => {
    const title = pageTitle("caseLaw.coverage.title");

    return createPublicLawHead({
      description: COVERAGE_DESCRIPTION,
      jsonLd: createLegalCollectionJsonLd({
        aboutName: "Case-law decisions",
        canonicalUrl: createPublicLawCanonicalUrl(COVERAGE_PATH),
        description: COVERAGE_DESCRIPTION,
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

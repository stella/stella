import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";

import { publicCaseLawHubPathFor } from "@/features/case-law/browse-hub-path";
import {
  publicCaseLawCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { latestDecisionsOptions } from "@/features/case-law/queries/decisions";
import { legislationShelfOptions } from "@/features/statutes/queries/statutes";
import { getMessageLocale, getTranslator } from "@/i18n/i18n-store";
import { resolveCaseLawRouteCountry } from "@/lib/case-law-route";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { optionalFlagSearchSchema } from "@/lib/schema";
import { routeSearchSchema } from "@/route-search-params";
import { statuteCountryOf } from "@/routes/law/-law-home/jurisdictions";
import { LawHomePage } from "@/routes/law/-law-home/law-home.page";
import { LawHomePending } from "@/routes/law/-law-home/law-home.pending";

const searchSchema = routeSearchSchema({
  country: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(3),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  ),
  /** Set by a decision link that resolved to nothing; shown once, then cleared. */
  notFound: optionalFlagSearchSchema,
});

type LawHomeSearch = v.InferOutput<typeof searchSchema>;

const createLawHomePath = ({ country }: LawHomeSearch): `/law${string}` =>
  country
    ? `/law?country=${encodeURIComponent(country.toLowerCase())}`
    : "/law";

export const Route = createFileRoute("/law/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  // A first visit starts in the jurisdiction the UI language points at, and
  // the URL says so, so the page and its columns agree on the scope. Other
  // locales use the generated list's first country. Server-side, because /law
  // is a public SSR path: the throw becomes a real HTTP redirect rather than a
  // client-only navigation that would serve crawlers an empty shell.
  beforeLoad: ({ search }) => {
    const country = resolveCaseLawRouteCountry({
      country: search.country,
      locale: getMessageLocale(),
    });
    if (country === null) {
      notFound({ throw: true });
      return;
    }
    const countryParam = toCaseLawCountryParam(country);
    if (search.country === countryParam) {
      return;
    }
    throw redirect({
      to: "/law",
      search: { ...search, country: countryParam },
      replace: true,
    });
  },
  loader: async ({ context: { queryClient }, deps }) => {
    const scope =
      publicCaseLawCountryFromParam(deps.country) ??
      panic("The law route loaded without a launch-ready country.");
    const statuteCountry = statuteCountryOf(scope);
    const [latest] = await Promise.all([
      ensureRouteQueryData(queryClient, latestDecisionsOptions(scope)),
      statuteCountry === null
        ? Promise.resolve(null)
        : ensureRouteQueryData(queryClient, legislationShelfOptions(scope)),
    ]);

    return {
      decisions: latest.courts.flatMap((group) => group.decisions),
    };
  },
  head: ({ loaderData, match }) => {
    const t = getTranslator();
    const title = pageTitle("common.legalDatabase");
    const description = t("caseLaw.seo.homeDescription");
    const path = createLawHomePath(match.search);

    return createPublicLawHead({
      canonicalPath: publicCaseLawHubPathFor(match.search.country),
      description,
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "caseLaw",
        items: loaderData
          ? loaderData.decisions.map((decision) => ({
              name: decision.caseNumber,
              url: createPublicLawCanonicalUrl(
                createCaseLawDecisionPath(
                  createCaseLawDecisionRouteParams({
                    caseNumber: decision.caseNumber,
                    country: decision.country,
                    court: decision.court,
                    decisionId: decision.id,
                    language: decision.language,
                    languageAlternates: decision.languageAlternates,
                    slug: decision.slug,
                  }),
                ),
              ),
            }))
          : [],
        name: title,
      }),
      path,
      title,
      type: "website",
    });
  },
  component: LawHomePage,
  pendingComponent: LawHomePending,
});

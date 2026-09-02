import { useState } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { PublicLawSearch } from "@/components/public-law-search";
import {
  CASE_LAW_ALL_COUNTRIES,
  caseLawCountryRegion,
  defaultCaseLawCountryForLocale,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { CaseLawBrowseLinks } from "@/features/case-law/components/case-law-browse-links";
import {
  caseLawCountryScope,
  openDecisionMatch,
} from "@/features/case-law/open-decision-match";
import {
  decisionFacetsOptions,
  latestDecisionsOptions,
} from "@/features/case-law/queries/decisions";
import { openStatuteMatch } from "@/features/statutes/open-statute-match";
import { legislationShelfOptions } from "@/features/statutes/queries/statutes";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@/features/statutes/statute-query-intent";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { getMessageLocale } from "@/i18n/i18n-store";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  LAW_HOME_JURISDICTION_CODES,
  LAW_HOME_JURISDICTIONS,
  type LawHomeDescriptor,
  type LawScope,
  lawHomeDescriptor,
  statuteCountryOf,
} from "@/routes/law/-law-home/jurisdictions";
import {
  IdentifierExamples,
  LegislationCard,
  ResearchTablesCard,
  TopCourtsCard,
} from "@/routes/law/-law-home/law-home-cards";
import {
  type LawHomeScope,
  LawScopeTabs,
} from "@/routes/law/-law-home/law-scope-tabs";

/** What the box accepts, and therefore what the results route may receive. */
const MAX_QUERY_LENGTH = 256;

/** Groups per card while the route's own data is still in flight. */
const PENDING_GROUP_KEYS = ["a", "b", "c"] as const;

/** The page's column: wide enough for two cards, narrow enough to read. */
const LAW_HOME_COLUMN_CLASS =
  "mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 md:px-6 md:py-8";

/** Courts get the wider column: their rows carry a headnote, statutes a date. */
const LAW_HOME_GRID_CLASS =
  "grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]";

const searchSchema = v.object({
  country: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(3),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  ),
  /** Set by a decision link that resolved to nothing; shown once, then cleared. */
  notFound: v.optional(v.boolean()),
});

type LawHomeSearch = v.InferOutput<typeof searchSchema>;

const createLawHomePath = ({ country }: LawHomeSearch): `/law${string}` =>
  country
    ? `/law?country=${encodeURIComponent(country.toLowerCase())}`
    : "/law";

const HOME_DESCRIPTION =
  "Public legal database: court decisions and consolidated statutes, searchable by identifier or by words.";

/**
 * The pill's jurisdictions: the ones the home describes, then any other the
 * facets report. The described ones are always offered, so the pill names
 * the route's jurisdiction even while the facets are unavailable.
 */
const pillJurisdictions = (
  facetCountries: readonly { value: string }[],
): string[] => {
  const codes: string[] = [...LAW_HOME_JURISDICTION_CODES];
  for (const bucket of facetCountries) {
    if (!codes.includes(bucket.value)) {
      codes.push(bucket.value);
    }
  }
  return codes;
};

/** The chips a jurisdiction offers: every example of every scope it lists. */
const descriptorExamples = (descriptor: LawHomeDescriptor): readonly string[] =>
  descriptor.scopes.flatMap((scope) => descriptor.examples[scope]);

/** Whether the entry belongs to the legislation corpus rather than case law. */
const wantsStatutes = (
  scope: LawHomeScope,
  intent: StatuteQueryIntent,
): boolean => {
  switch (scope) {
    case "all":
      return intent.type === "act";
    case "decisions":
      return false;
    case "statutes":
      return true;
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
};

export const Route = createFileRoute("/law/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  // A first visit starts in the jurisdiction the UI language points at, and
  // the URL says so, so the page and its cards agree on the scope. Readers in
  // other languages, and crawlers, start unscoped. Server-side, because /law
  // is a public SSR path: the throw becomes a real HTTP redirect rather than
  // a client-only navigation that would serve crawlers an empty shell.
  beforeLoad: ({ search }) => {
    if (search.country !== undefined) {
      return;
    }
    const country = defaultCaseLawCountryForLocale(getMessageLocale());
    if (country === null) {
      return;
    }
    throw redirect({
      to: "/law",
      search: { ...search, country: toCaseLawCountryParam(country) },
      replace: true,
    });
  },
  loader: async ({ context: { queryClient }, deps }) => {
    const scope = caseLawCountryScope(deps.country);
    const statuteCountry = statuteCountryOf(scope);
    const [latest] = await Promise.all([
      scope === undefined
        ? Promise.resolve(null)
        : ensureRouteQueryData(queryClient, latestDecisionsOptions(scope)),
      // Unscoped: the pill offers every jurisdiction the corpus holds.
      ensureRouteQueryData(queryClient, decisionFacetsOptions()),
      scope === undefined || statuteCountry === null
        ? Promise.resolve(null)
        : ensureRouteQueryData(queryClient, legislationShelfOptions(scope)),
    ]);

    return {
      decisions:
        latest === null
          ? []
          : latest.courts.flatMap((group) => group.decisions),
    };
  },
  head: ({ loaderData, match }) => {
    const title = pageTitle("common.legalDatabase");
    const path = createLawHomePath(match.search);

    return createPublicLawHead({
      description: HOME_DESCRIPTION,
      jsonLd: createLegalCollectionJsonLd({
        aboutName: "Case-law decisions",
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description: HOME_DESCRIPTION,
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
  component: LawHome,
  pendingComponent: LawHomePending,
});

// The loader fetches the facets and both shelves, so without a
// pendingComponent the route flashes the glowing logo. Render the page's real
// shape: the title and the box, the filter row, then the two columns.
function LawHomePending() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={LAW_HOME_COLUMN_CLASS}>
        <section className="flex flex-col gap-4">
          <LawHomeTitle>{t("common.legalDatabase")}</LawHomeTitle>
          <Skeleton className="h-10 w-full rounded-lg" />
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-8 w-52 rounded-md" />
            <Skeleton className="h-8 w-40 rounded-md" />
            <Skeleton className="h-6 w-64 rounded-md" />
          </div>
        </section>
        <div className={LAW_HOME_GRID_CLASS}>
          <div className="border-border/60 flex flex-col gap-4 rounded-lg border p-4">
            <Skeleton className="h-3 w-32" />
            {PENDING_GROUP_KEYS.map((key) => (
              <div className="flex flex-col gap-2" key={key}>
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ))}
          </div>
          <div className="border-border/60 flex flex-col gap-4 rounded-lg border p-4">
            <Skeleton className="h-3 w-28" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

const LawHomeTitle = ({ children }: { children: string }) => (
  <h1 className="text-2xl font-semibold tracking-tight text-balance">
    {children}
  </h1>
);

function LawHome() {
  const t = useTranslations();
  const format = useFormatter();
  const uiLocale = useLocale();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const routeNavigate = Route.useNavigate();
  const country = Route.useSearch({ select: (search) => search.country });
  const notFound = Route.useSearch({ select: (search) => search.notFound });

  useExternalSyncEffect(() => {
    if (!notFound) {
      return;
    }
    stellaToast.add({ title: t("caseLaw.decisionNotFound"), type: "error" });
    detached(
      routeNavigate({
        replace: true,
        search: (previous) => ({ ...previous, notFound: undefined }),
      }),
      "law-home.clear-not-found",
    );
  }, [notFound, routeNavigate, t]);

  const countryParam = country ?? CASE_LAW_ALL_COUNTRIES;
  const scope = caseLawCountryScope(country);
  const statuteCountry = statuteCountryOf(scope);
  const descriptor = lawHomeDescriptor(scope);

  const [queryInput, setQueryInput] = useState("");
  const [requestedScope, setRequestedScope] = useState<LawHomeScope>("all");

  // Unscoped, the pill spans every jurisdiction and only case law is common
  // to all of them, so the box reads an entry as case law.
  const corpora: readonly LawScope[] =
    descriptor === null ? ["decisions"] : descriptor.scopes;
  // A jurisdiction switch can retire the chosen scope; fall back rather than
  // resetting the choice in an effect.
  const activeScope: LawHomeScope =
    requestedScope !== "all" && !corpora.includes(requestedScope)
      ? "all"
      : requestedScope;

  const { data: facets } = useSuspenseQuery(decisionFacetsOptions());
  const { data: latest } = useQuery({
    ...latestDecisionsOptions(scope ?? ""),
    enabled: scope !== undefined,
  });
  const { data: shelf } = useQuery({
    ...legislationShelfOptions(scope ?? ""),
    enabled: scope !== undefined && statuteCountry !== null,
  });

  const countryName = (code: string): string => {
    const region = caseLawCountryRegion(code);
    return region === null
      ? code
      : format.displayName(region, { type: "region" });
  };

  /**
   * The one dispatch every entry takes, whether typed and submitted or
   * pressed as a chip: the named act, else the named decision, else the
   * results screen of whichever corpus the scope points at.
   */
  const runEntry = async (entry: string) => {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      return;
    }

    if (
      statuteCountry !== null &&
      wantsStatutes(activeScope, parseStatuteQuery(statuteCountry, trimmed))
    ) {
      const opened = await openStatuteMatch({
        country: statuteCountry,
        navigate,
        q: trimmed,
        queryClient,
      });
      if (!opened) {
        await navigate({
          params: { country: statuteCountry },
          search: { q: trimmed },
          to: "/law/$country/statutes",
        });
      }
      return;
    }

    const opened = await openDecisionMatch({
      navigate,
      queryClient,
      search: { country: countryParam, q: trimmed },
      uiLocale,
    });
    if (opened) {
      return;
    }
    await navigate({
      search: { country: countryParam, q: trimmed },
      to: "/law/cases",
    });
  };

  const selectExample = (example: string) => {
    setQueryInput(example);
    detached(runEntry(example), "law-home.example");
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={LAW_HOME_COLUMN_CLASS}>
        {/* The one way in: the box, with what narrows it and what it accepts
            right under it. Everything below is a sample of what it reaches. */}
        <section className="flex flex-col gap-4">
          <LawHomeTitle>{t("common.legalDatabase")}</LawHomeTitle>
          <PublicLawSearch
            askPrompt={(entry) =>
              scope === undefined
                ? t("caseLaw.searchAskPromptAll", { query: entry })
                : t("caseLaw.searchAskPrompt", {
                    country: countryName(scope),
                    query: entry,
                  })
            }
            countries={[
              { label: t("common.all"), value: CASE_LAW_ALL_COUNTRIES },
              ...pillJurisdictions(facets.country).map((code) => ({
                label: countryName(code),
                value: toCaseLawCountryParam(code),
              })),
            ]}
            country={countryParam}
            filters={
              <LawScopeTabs
                corpora={corpora}
                onScopeChange={setRequestedScope}
                scope={activeScope}
              />
            }
            hints={
              descriptor === null ? null : (
                <IdentifierExamples
                  examples={descriptorExamples(descriptor)}
                  onExampleSelect={selectExample}
                />
              )
            }
            layout="entry"
            maxLength={MAX_QUERY_LENGTH}
            onCountryChange={(next) => {
              detached(
                routeNavigate({ replace: true, search: { country: next } }),
                "law-home.switch-country",
              );
            }}
            onQueryChange={setQueryInput}
            onSubmit={() => detached(runEntry(queryInput), "law-home.submit")}
            placeholder={t("lawHome.searchPlaceholder")}
            query={queryInput}
            searchLabel={t("lawHome.searchLabel")}
          />
          {scope === undefined && (
            <div className="flex flex-col gap-1.5">
              {LAW_HOME_JURISDICTION_CODES.map((code) => (
                <IdentifierExamples
                  examples={descriptorExamples(LAW_HOME_JURISDICTIONS[code])}
                  key={code}
                  label={countryName(code)}
                  onExampleSelect={selectExample}
                />
              ))}
            </div>
          )}
        </section>

        {scope !== undefined && (
          <div className={LAW_HOME_GRID_CLASS}>
            {latest !== undefined && (
              <TopCourtsCard
                countryParam={countryParam}
                groups={latest.courts}
              />
            )}
            <div className="flex min-w-0 flex-col gap-4">
              {shelf !== undefined && statuteCountry !== null && (
                <LegislationCard country={statuteCountry} shelf={shelf} />
              )}
              <ResearchTablesCard />
            </div>
          </div>
        )}

        <CaseLawBrowseLinks facets={facets} />
      </div>
    </main>
  );
}

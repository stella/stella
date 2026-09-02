import { Fragment, useState } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import {
  ActivityIcon,
  BookOpenIcon,
  GlobeIcon,
  HistoryIcon,
  ScaleIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { ComposerPicker } from "@stll/ui/composer";
import {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingButton,
  LandingGreeting,
  LandingItemText,
  LandingLayout,
  LandingSection,
} from "@stll/ui/landing";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import {
  CASE_LAW_ALL_COUNTRIES,
  caseLawCountryRegion,
  defaultCaseLawCountryForLocale,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { CaseLawBrowseLinks } from "@/features/case-law/components/case-law-browse-links";
import {
  decisionLinkElement,
  formatDecisionDate,
} from "@/features/case-law/components/decision-cells";
import {
  caseLawCountryScope,
  openDecisionMatch,
} from "@/features/case-law/open-decision-match";
import {
  decisionFacetsOptions,
  latestDecisionsOptions,
} from "@/features/case-law/queries/decisions";
import { openStatuteMatch } from "@/features/statutes/open-statute-match";
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
  type LawScope,
  lawHomeDescriptor,
  statuteCountryOf,
} from "@/routes/law/-law-home/jurisdictions";
import { LawDatabaseStatus } from "@/routes/law/-law-home/law-database-status";
import { LawEntryBox } from "@/routes/law/-law-home/law-entry-box";
import {
  PLACEHOLDER_RECENT_SEARCHES,
  PLACEHOLDER_SIGNALS,
} from "@/routes/law/-law-home/law-home-placeholders";
import {
  type LawHomeScope,
  LawScopePicker,
} from "@/routes/law/-law-home/law-scope-picker";

/** What the box accepts, and therefore what the results route may receive. */
const MAX_QUERY_LENGTH = 256;

/** Decisions per court in the top-courts column: a sample, not a list. */
const DECISIONS_PER_COURT = 2;

/** Rows per column while the route's own data is still in flight. */
const PENDING_ROW_KEYS = ["a", "b", "c"] as const;

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
  // the URL says so, so the page and its columns agree on the scope. Readers
  // in other languages, and crawlers, start unscoped. Server-side, because
  // /law is a public SSR path: the throw becomes a real HTTP redirect rather
  // than a client-only navigation that would serve crawlers an empty shell.
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
    const [latest] = await Promise.all([
      scope === undefined
        ? Promise.resolve(null)
        : ensureRouteQueryData(queryClient, latestDecisionsOptions(scope)),
      // Unscoped: the pill offers every jurisdiction the corpus holds.
      ensureRouteQueryData(queryClient, decisionFacetsOptions()),
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

// The loader fetches the facets and the top-court shelf, so without a
// pendingComponent the route flashes the glowing logo. Render the page's real
// shape: the greeting, the box, then the three columns.
function LawHomePending() {
  const t = useTranslations();

  return (
    <LandingLayout
      hero={
        <>
          <LawHomeGreeting>{t("lawHome.prompt")}</LawHomeGreeting>
          <Skeleton className="h-27 w-full rounded-2xl" />
        </>
      }
    >
      {PENDING_ROW_KEYS.map((column) => (
        <div className="flex flex-col gap-3" key={column}>
          <Skeleton className="h-3 w-32" />
          {PENDING_ROW_KEYS.map((row) => (
            <div className="flex flex-col gap-1 px-2 py-1.5" key={row}>
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ))}
        </div>
      ))}
    </LandingLayout>
  );
}

/** The section's mark over the question, as the chat home greets. */
const LawHomeGreeting = ({ children }: { children: string }) => (
  <LandingGreeting icon={<BookOpenIcon className="size-6" />}>
    {children}
  </LandingGreeting>
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

  const countryName = (code: string): string => {
    const region = caseLawCountryRegion(code);
    return region === null
      ? code
      : format.displayName(region, { type: "region" });
  };

  /**
   * The one dispatch every entry takes, whether typed and submitted or
   * pressed as a row: the named act, else the named decision, else the
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

  const rerunSearch = (entry: string) => {
    setQueryInput(entry);
    detached(runEntry(entry), "law-home.recent-search");
  };

  const topCourtRows =
    latest?.courts.flatMap((group) =>
      group.decisions.slice(0, DECISIONS_PER_COURT).map((decision) => ({
        decision,
        court: group.court,
      })),
    ) ?? [];

  return (
    <LandingLayout
      hero={
        <>
          <LawHomeGreeting>{t("lawHome.prompt")}</LawHomeGreeting>
          <LawEntryBox
            askPrompt={(entry) =>
              scope === undefined
                ? t("caseLaw.searchAskPromptAll", { query: entry })
                : t("caseLaw.searchAskPrompt", {
                    country: countryName(scope),
                    query: entry,
                  })
            }
            maxLength={MAX_QUERY_LENGTH}
            onQueryChange={setQueryInput}
            onSubmit={() => detached(runEntry(queryInput), "law-home.submit")}
            pickers={
              <>
                <ComposerPicker
                  ariaLabel={t("common.country")}
                  icon={<GlobeIcon />}
                  onChange={(next) => {
                    detached(
                      routeNavigate({
                        replace: true,
                        search: { country: next },
                      }),
                      "law-home.switch-country",
                    );
                  }}
                  options={[
                    { label: t("common.all"), value: CASE_LAW_ALL_COUNTRIES },
                    ...pillJurisdictions(facets.country).map((code) => ({
                      label: countryName(code),
                      value: toCaseLawCountryParam(code),
                    })),
                  ]}
                  value={countryParam}
                />
                <LawScopePicker
                  corpora={corpora}
                  onScopeChange={setRequestedScope}
                  scope={activeScope}
                />
              </>
            }
            placeholder={t("lawHome.searchPlaceholder")}
            query={queryInput}
            searchLabel={t("lawHome.searchLabel")}
            status={<LawDatabaseStatus />}
          />
        </>
      }
    >
      {scope !== undefined && (
        <LandingSection
          heading={
            <Link
              className={LANDING_SECTION_HEADING_CLASS}
              search={{ country: countryParam }}
              to="/law/cases"
            >
              <ScaleIcon className="size-4" />
              {t("lawHome.topCourts")}
            </Link>
          }
        >
          {topCourtRows.map(({ court, decision }) => {
            const date =
              decision.decisionDate === null
                ? null
                : formatDecisionDate(decision.decisionDate, format);
            return (
              <Fragment key={decision.id}>
                {decisionLinkElement(
                  createCaseLawDecisionRouteParams({
                    caseNumber: decision.caseNumber,
                    country: decision.country,
                    court: decision.court,
                    decisionId: decision.id,
                    language: decision.language,
                    languageAlternates: decision.languageAlternates,
                    slug: decision.slug,
                  }),
                  LANDING_ROW_CLASS,
                  <LandingItemText
                    meta={date === null ? court : `${court} · ${date}`}
                    title={decision.caseNumber}
                  />,
                )}
              </Fragment>
            );
          })}
        </LandingSection>
      )}
      <LandingSection
        heading={
          <span className={LANDING_SECTION_HEADING_CLASS}>
            <ActivityIcon className="size-4" />
            {t("lawHome.signals")}
          </span>
        }
      >
        {PLACEHOLDER_SIGNALS.map((signal) => (
          <div className="px-2 py-1.5" key={signal.title}>
            <LandingItemText meta={signal.meta} title={signal.title} />
          </div>
        ))}
      </LandingSection>
      <LandingSection
        heading={
          <span className={LANDING_SECTION_HEADING_CLASS}>
            <HistoryIcon className="size-4" />
            {t("search.recentSearches")}
          </span>
        }
      >
        {PLACEHOLDER_RECENT_SEARCHES.map((search) => (
          <LandingButton
            icon={<SearchIcon className="size-4" />}
            key={search.query}
            meta={search.when}
            onClick={() => rerunSearch(search.query)}
            title={search.query}
          />
        ))}
      </LandingSection>
      <div className="@2xl:col-span-3">
        <CaseLawBrowseLinks facets={facets} />
      </div>
    </LandingLayout>
  );
}

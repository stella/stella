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
import { panic } from "better-result";
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
  LandingEmpty,
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
  caseLawCorpusStatusOptions,
  decisionFacetsOptions,
  latestDecisionsOptions,
} from "@/features/case-law/queries/decisions";
import { openStatuteMatch } from "@/features/statutes/open-statute-match";
import { legislationShelfOptions } from "@/features/statutes/queries/statutes";
import { formatValidityDate } from "@/features/statutes/statute-format";
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
import { recordLawSearch, useLawSearchHistory } from "@/lib/law-search-history";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  LAW_HOME_JURISDICTION_CODES,
  type LawScope,
  lawHomeDescriptor,
  statuteCountryOf,
} from "@/routes/law/-law-home/jurisdictions";
import { LawDatabaseStatus } from "@/routes/law/-law-home/law-database-status";
import { LawEntryBox } from "@/routes/law/-law-home/law-entry-box";
import {
  type LawHomeScope,
  LawScopePicker,
} from "@/routes/law/-law-home/law-scope-picker";

/** What the box accepts, and therefore what the results route may receive. */
const MAX_QUERY_LENGTH = 256;

/** Decisions per court in the top-courts column: a sample, not a list. */
const DECISIONS_PER_COURT = 2;

/** Acts per side of the legislation shelf in the signals column. */
const ACTS_PER_SHELF_SIDE = 3;

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
      scope satisfies never;
      return panic(`Unhandled scope: ${String(scope)}`);
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
    const statuteCountry = statuteCountryOf(scope);
    const [latest] = await Promise.all([
      scope === undefined
        ? Promise.resolve(null)
        : ensureRouteQueryData(queryClient, latestDecisionsOptions(scope)),
      // Unscoped: the pill offers every jurisdiction the corpus holds.
      ensureRouteQueryData(queryClient, decisionFacetsOptions()),
      ensureRouteQueryData(queryClient, caseLawCorpusStatusOptions()),
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
  const { data: shelf } = useQuery({
    ...legislationShelfOptions(scope ?? ""),
    enabled: scope !== undefined && statuteCountry !== null,
  });
  const history = useLawSearchHistory();

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
    recordLawSearch(trimmed);

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
    latest === undefined
      ? []
      : latest.courts.flatMap((group) =>
          group.decisions.slice(0, DECISIONS_PER_COURT).map((decision) => ({
            decision,
            court: group.court,
          })),
        );
  // What moved in the law lately: acts that just came into force, then acts
  // about to. Court signals join here once the corpus reports them.
  const signalRows =
    shelf === undefined
      ? []
      : [
          ...shelf.recentlyInForce
            .slice(0, ACTS_PER_SHELF_SIDE)
            .map((item) => ({ item, side: "recentlyInForce" as const })),
          ...shelf.enteringIntoForce
            .slice(0, ACTS_PER_SHELF_SIDE)
            .map((item) => ({ item, side: "enteringIntoForce" as const })),
        ];
  const signalLine = (
    side: "enteringIntoForce" | "recentlyInForce",
    validFrom: string | null,
  ): string | null => {
    const date = formatValidityDate(validFrom, format);
    if (date === null) {
      return null;
    }
    return side === "recentlyInForce"
      ? t("statutes.inForceSince", { date })
      : t("lawHome.inForceFrom", { date });
  };

  return (
    <LandingLayout
      footer={<CaseLawBrowseLinks facets={facets} />}
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
          statuteCountry === null ? (
            <span className={LANDING_SECTION_HEADING_CLASS}>
              <ActivityIcon className="size-4" />
              {t("lawHome.signals")}
            </span>
          ) : (
            <Link
              className={LANDING_SECTION_HEADING_CLASS}
              params={{ country: statuteCountry }}
              to="/law/$country/statutes"
            >
              <ActivityIcon className="size-4" />
              {t("lawHome.signals")}
            </Link>
          )
        }
      >
        {signalRows.length > 0 && statuteCountry !== null ? (
          signalRows.map(({ item, side }) => (
            <Link
              className={LANDING_ROW_CLASS}
              key={item.id}
              params={{ country: statuteCountry, documentId: item.id }}
              to="/law/$country/statutes/$documentId"
            >
              <LandingItemText
                meta={signalLine(side, item.versionValidFrom)}
                title={item.title}
              />
            </Link>
          ))
        ) : (
          <LandingEmpty>{t("lawHome.noSignals")}</LandingEmpty>
        )}
      </LandingSection>
      <LandingSection
        heading={
          <span className={LANDING_SECTION_HEADING_CLASS}>
            <HistoryIcon className="size-4" />
            {t("search.recentSearches")}
          </span>
        }
      >
        {history.length > 0 ? (
          history.map((entry) => (
            <LandingButton
              icon={<SearchIcon className="size-4" />}
              key={entry.query}
              meta={formatRelativeTime(entry.at)}
              onClick={() => rerunSearch(entry.query)}
              title={entry.query}
            />
          ))
        ) : (
          <LandingEmpty>{t("lawHome.noRecentSearches")}</LandingEmpty>
        )}
      </LandingSection>
    </LandingLayout>
  );
}

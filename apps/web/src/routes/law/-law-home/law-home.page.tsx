import { Fragment, useDeferredValue, useState } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@stll/api-contract/statute-query-intent";
import { createStatuteRouteParams } from "@stll/api-contract/statute-route";
import { useExternalSyncEffect } from "@stll/ui/effects";
import {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingEmpty,
  LandingItemText,
} from "@stll/ui/landing";

import { publicLawAskScope } from "@/components/public-law-search";
import {
  publicCaseLawCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import {
  decisionLinkElement,
  formatDecisionDate,
} from "@/features/case-law/components/decision-cells";
import { useDecisionColumnPreferences } from "@/features/case-law/decision-column-preferences";
import { openDecisionMatch } from "@/features/case-law/open-decision-match";
import { latestDecisionsOptions } from "@/features/case-law/queries/decisions";
import { useCaseLawReadingLanguages } from "@/features/case-law/reading-languages";
import { useLawHistory } from "@/features/law-search-history/law-search-history-query";
import { StatuteSignalText } from "@/features/statutes/components/statute-signal-text";
import { openStatuteMatch } from "@/features/statutes/open-statute-match";
import { legislationShelfOptions } from "@/features/statutes/queries/statutes";
import { useFormatter } from "@/i18n/formatting-context";
import { caseLawCountryName } from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { notifyUserProblem } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { formatValidityDate } from "@/lib/statutes/statute-format";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  lawHomeDescriptor,
  type LawScope,
  statuteCountryOf,
} from "@/routes/law/-law-home/jurisdictions";
import { LawDatabaseStatus } from "@/routes/law/-law-home/law-database-status";
import { LawEntryBox } from "@/routes/law/-law-home/law-entry-box";
import {
  LawHomeShell,
  LawHomeSignalsLabel,
  LawHomeTopCourtsLabel,
} from "@/routes/law/-law-home/law-home.pending";
import { LawRecent } from "@/routes/law/-law-home/law-recent";
import {
  type LawHomeScope,
  LawScopePicker,
} from "@/routes/law/-law-home/law-scope-picker";

/** Decisions per court in the top-courts column: a sample, not a list. */
const DECISIONS_PER_COURT = 2;

/** Acts per side of the legislation shelf in the signals column. */
const ACTS_PER_SHELF_SIDE = 3;

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

const routeApi = getRouteApi("/law/");

export function LawHomePage() {
  const t = useTranslations();
  const format = useFormatter();
  const readingLanguages = useCaseLawReadingLanguages();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const routeNavigate = routeApi.useNavigate();
  const country = routeApi.useSearch({ select: (search) => search.country });
  const decisionNotFound = routeApi.useSearch({
    select: (search) => search.notFound,
  });

  useExternalSyncEffect(() => {
    if (!decisionNotFound) {
      return;
    }
    notifyUserProblem(t("caseLaw.decisionNotFound"));
    detached(
      routeNavigate({
        replace: true,
        search: (previous) => ({ ...previous, notFound: undefined }),
      }),
      "law-home.clear-not-found",
    );
  }, [decisionNotFound, routeNavigate, t]);

  const scope =
    publicCaseLawCountryFromParam(country) ??
    panic("The law route rendered without a launch-ready country.");
  // The same list Recent shows, so recording and listing share one query.
  const { record: historyRecord } = useLawHistory({
    filter: "all",
    country: scope,
  });
  const countryParam = toCaseLawCountryParam(scope);
  // The results page reads this jurisdiction's stored excerpt length too, so
  // the lookup below and the list it falls back to share one cached result set.
  const { layout } = useDecisionColumnPreferences(countryParam);
  const statuteCountry = statuteCountryOf(scope);
  const descriptor = lawHomeDescriptor(scope);

  const [queryInput, setQueryInput] = useState("");
  const [requestedScope, setRequestedScope] = useState<LawHomeScope>("all");

  const corpora: readonly LawScope[] =
    descriptor === null ? ["decisions"] : descriptor.scopes;
  // A jurisdiction switch can retire the chosen scope; fall back rather than
  // resetting the choice in an effect.
  const activeScope: LawHomeScope =
    requestedScope !== "all" && !corpora.includes(requestedScope)
      ? "all"
      : requestedScope;

  // Deferred: the reader's practice languages arrive after the first paint,
  // and the shelf already drawn stays while it is read again in them, rather
  // than suspending back to its skeleton.
  const shelfLanguages = useDeferredValue(readingLanguages);
  const { data: latest } = useSuspenseQuery(
    latestDecisionsOptions(scope, shelfLanguages),
  );
  const shelfQuery = useQuery({
    ...legislationShelfOptions(scope),
    enabled: statuteCountry !== null,
  });
  const shelfView = queryView(shelfQuery);
  useQueryViewError(shelfView, "LawHome:query");
  const shelf = shelfView.type === "items" ? shelfView.items : undefined;

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
    historyRecord.mutate({ kind: "search", query: trimmed, country: scope });

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
      excerpt: layout.excerpt,
      navigate,
      queryClient,
      search: { country: countryParam, q: trimmed },
      readingLanguages,
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

  const topCourtRows = latest.courts.flatMap((group) =>
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
    <LawHomeShell
      entry={
        <LawEntryBox
          askScope={publicLawAskScope(
            "case_law",
            scope,
            t("chat.mention.corpus.caseLaw", {
              country: caseLawCountryName(format, scope),
            }),
          )}
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          onQueryChange={setQueryInput}
          onSubmit={() => detached(runEntry(queryInput), "law-home.submit")}
          pickers={
            <LawScopePicker
              corpora={corpora}
              onScopeChange={setRequestedScope}
              scope={activeScope}
            />
          }
          placeholder={t("lawHome.searchPlaceholder")}
          query={queryInput}
          searchLabel={t("lawHome.searchLabel")}
          status={<LawDatabaseStatus country={scope} />}
        />
      }
      recent={<LawRecent country={scope} onSearch={rerunSearch} />}
      topCourts={{
        heading: (
          <Link
            className={LANDING_SECTION_HEADING_CLASS}
            search={{ country: countryParam }}
            to="/law/cases"
          >
            <LawHomeTopCourtsLabel />
          </Link>
        ),
        rows: (
          <>
            {topCourtRows.map(({ court, decision }) => {
              const date =
                decision.decisionDate === null
                  ? null
                  : formatDecisionDate(decision.decisionDate, format);
              return (
                <Fragment key={decision.id}>
                  {decisionLinkElement({
                    children: (
                      <LandingItemText
                        meta={date === null ? court : `${court} · ${date}`}
                        title={decision.caseNumber}
                      />
                    ),
                    className: LANDING_ROW_CLASS,
                    params: createCaseLawDecisionRouteParams({
                      caseNumber: decision.caseNumber,
                      country: decision.country,
                      court: decision.court,
                      decisionId: decision.id,
                      language: decision.language,
                      languageAlternates: decision.languageAlternates,
                      slug: decision.slug,
                    }),
                  })}
                </Fragment>
              );
            })}
            {/* What the corpus says about itself: every country it holds, the
            ones the public search cannot reach yet included. */}
            <Link
              className="text-muted-foreground hover:text-foreground px-2 pt-2 text-xs underline underline-offset-2"
              to="/law/coverage"
            >
              {t("caseLaw.coverage.title")}
            </Link>
          </>
        ),
      }}
      signals={{
        heading:
          statuteCountry === null ? (
            <span className={LANDING_SECTION_HEADING_CLASS}>
              <LawHomeSignalsLabel />
            </span>
          ) : (
            <Link
              className={LANDING_SECTION_HEADING_CLASS}
              params={{ country: statuteCountry }}
              to="/law/$country/statutes"
            >
              <LawHomeSignalsLabel />
            </Link>
          ),
        rows:
          signalRows.length > 0 && statuteCountry !== null ? (
            signalRows.map(({ item, side }) => (
              <Link
                className={LANDING_ROW_CLASS}
                key={item.id}
                params={createStatuteRouteParams({
                  country: statuteCountry,
                  documentId: item.id,
                  eli: item.eli,
                  slug: item.slug,
                  version: null,
                })}
                to="/law/$country/statutes/$slug"
              >
                <StatuteSignalText
                  meta={signalLine(side, item.versionValidFrom)}
                  statute={item}
                />
              </Link>
            ))
          ) : (
            <LandingEmpty>{t("lawHome.noSignals")}</LandingEmpty>
          ),
      }}
    />
  );
}

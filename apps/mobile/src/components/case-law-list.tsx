import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useLocale, useTranslations } from "use-intl";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { DecisionRow } from "@/components/decision-row";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { useHeaderSearch } from "@/components/header-search";
import { PagingFooter, RetryButton } from "@/components/retry-button";
import type { PagingState } from "@/components/retry-button";
import { epochMilliseconds } from "@/connection/clock";
import type { Load } from "@/state/api-request";
import {
  appendDecisionsPage,
  CASE_LAW_COUNTRIES,
  countryLabel,
  defaultCaseLawCountry,
  listDecisions,
} from "@/state/case-law";
import type { CaseLawCountry, DecisionsPage } from "@/state/case-law";
import { useAppColors } from "@/theme";

type DecisionsRequest = {
  readonly country: CaseLawCountry;
  readonly load: Promise<Load<DecisionsPage>>;
  readonly query: string;
};

/**
 * The case law of one jurisdiction: its newest decisions, or those matching
 * what was typed into the header's search field once typing paused, as the
 * web's case-law index lists them. A choice of jurisdiction heads the list.
 */
export const CaseLawList = ({ serverUrl }: { serverUrl: string }) => {
  const colors = useAppColors();
  const locale = useLocale();
  const { settledQuery } = useHeaderSearch();
  const query = settledQuery.slice(0, SEARCH_QUERY_MAX_LENGTH).trim();
  const loadDecisions = async (
    country: CaseLawCountry,
    searched: string,
  ): Promise<Load<DecisionsPage>> => ({
    loadedAt: epochMilliseconds(),
    result: await listDecisions({ country, fetch, query: searched, serverUrl }),
  });
  const [request, setRequest] = useState<DecisionsRequest>(() => {
    const country = defaultCaseLawCountry(locale);
    return { country, load: loadDecisions(country, query), query };
  });
  const [refreshing, startRefresh] = useTransition();
  // A settled search the showing load did not ask for starts the next one.
  if (query !== request.query) {
    setRequest({
      country: request.country,
      load: loadDecisions(request.country, query),
      query,
    });
  }
  const show = (country: CaseLawCountry) => {
    setRequest({ country, load: loadDecisions(country, query), query });
  };
  const reload = () => {
    startRefresh(() => {
      show(request.country);
    });
  };

  return (
    <Suspense
      fallback={<ActivityIndicator className="flex-1" color={colors.muted} />}
    >
      <LoadedDecisions
        onCountry={show}
        onReload={reload}
        refreshing={refreshing}
        request={request}
        serverUrl={serverUrl}
      />
    </Suspense>
  );
};

/** The first page a request returned, continued as the list scrolls. */
const LoadedDecisions = ({
  onCountry,
  onReload,
  refreshing,
  request,
  serverUrl,
}: {
  onCountry: (country: CaseLawCountry) => void;
  onReload: () => void;
  refreshing: boolean;
  request: DecisionsRequest;
  serverUrl: string;
}) => {
  const { loadedAt, result } = use(request.load);
  return (
    <DecisionTimeline
      country={request.country}
      firstPage={Result.isOk(result) ? result.value : undefined}
      // A new request starts the list over from its first page.
      key={loadedAt}
      onCountry={onCountry}
      onReload={onReload}
      query={request.query}
      refreshing={refreshing}
      serverUrl={serverUrl}
    />
  );
};

const DecisionTimeline = ({
  country,
  firstPage,
  onCountry,
  onReload,
  query,
  refreshing,
  serverUrl,
}: {
  country: CaseLawCountry;
  firstPage: DecisionsPage | undefined;
  onCountry: (country: CaseLawCountry) => void;
  onReload: () => void;
  query: string;
  refreshing: boolean;
  serverUrl: string;
}) => {
  const t = useTranslations("law");
  const colors = useAppColors();
  const [decisions, setDecisions] = useState(firstPage?.decisions ?? []);
  const [cursor, setCursor] = useState(firstPage?.nextCursor ?? null);
  const [more, setMore] = useState<PagingState>("idle");

  const loadMore = async () => {
    if (cursor === null || more === "loading") {
      return;
    }
    setMore("loading");
    const next = await listDecisions({
      country,
      cursor,
      fetch,
      query,
      serverUrl,
    });
    if (Result.isOk(next)) {
      setDecisions((loaded) =>
        appendDecisionsPage(loaded, next.value.decisions),
      );
      setCursor(next.value.nextCursor);
      setMore("idle");
      return;
    }
    setMore("failed");
  };

  return (
    <FlatList
      contentContainerStyle={screenStyles.content}
      // The header is the platform's translucent bar; the list scrolls under it.
      contentInsetAdjustmentBehavior="automatic"
      data={decisions}
      keyExtractor={(decision) => decision.id}
      keyboardDismissMode="on-drag"
      ListEmptyComponent={
        firstPage === undefined ? (
          <EmptyCard description={t("loadFailed")} title={t("unavailable")}>
            <RetryButton label={t("retry")} onPress={onReload} />
          </EmptyCard>
        ) : (
          <EmptyCard description={t("noResultsHint")} title={t("noResults")} />
        )
      }
      ListFooterComponent={
        <PagingFooter
          label={t("retry")}
          onRetry={() => {
            void loadMore();
          }}
          state={more}
        />
      }
      ListHeaderComponent={
        <View className="gap-2 pb-1">
          <ScrollView
            accessibilityRole="tablist"
            contentContainerStyle={{ gap: 6 }}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {CASE_LAW_COUNTRIES.map((option) => (
              <Button
                accessibilityState={{ selected: option === country }}
                key={option}
                onPress={() => {
                  if (option !== country) {
                    onCountry(option);
                  }
                }}
                size="sm"
                variant={option === country ? "secondary" : "ghost"}
              >
                {countryLabel(option)}
              </Button>
            ))}
          </ScrollView>
          {query === "" ? <Text variant="section">{t("newest")}</Text> : null}
        </View>
      }
      onEndReached={() => {
        void loadMore();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item }) => <DecisionRow decision={item} />}
    />
  );
};

import { useEffect, useReducer, useRef, useState } from "react";

import { Result } from "better-result";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { DecisionRow } from "@/components/decision-row";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { EntityRow } from "@/components/entity-row";
import { LoadFailedCard } from "@/components/load-failure";
import { useRecentSearches } from "@/components/use-recent-searches";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { HistoryIcon, XIcon } from "@/icons.gen";
import {
  IDLE_SEARCH,
  NO_QUALIFIERS,
  qualifierChips,
  SEARCH_DEBOUNCE_MS,
  searchResultRoute,
  searchStella,
  searchText,
  searchViewReducer,
  shownPage,
  toggleQualifier,
} from "@/state/search";
import type {
  QualifierChip,
  SearchQualifiers,
  SearchResult,
  SearchResultType,
  SearchView,
} from "@/state/search";
import { useAppColors, useUiColors } from "@/theme";

/** The catalogue key naming each result type on its chip. */
const TYPE_LABELS = {
  document: "document",
  matter: "matter",
  task: "task",
  "case-law": "caseLaw",
  chat: "chat",
  folder: "folder",
  message: "message",
  link: "link",
} as const satisfies Record<SearchResultType, string>;

/**
 * Search across stella, as GitHub's app searches GitHub: a field with a
 * clear button, the recent searches under it while it is empty, and once
 * something is typed, chips that narrow the search by result type and
 * matter, and the results, each opening the screen its kind already has.
 */
const SearchScreen = () => {
  const { state } = useSession();
  if (state.status !== "signed-in") {
    return null;
  }
  const { serverUrl, userId } = state.source.session();
  // One screen per account, so nothing typed or picked carries over to another.
  return <SearchStella key={`${serverUrl} ${userId}`} source={state.source} />;
};

export default SearchScreen;

const SearchStella = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("search");
  const router = useRouter();
  const colors = useAppColors();
  const ui = useUiColors();
  const { end } = useSession();
  const recents = useRecentSearches(source);
  const [query, setQuery] = useState("");
  const [qualifiers, setQualifiers] = useState(NO_QUALIFIERS);
  const [matterNames, setMatterNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [view, dispatch] = useReducer(searchViewReducer, IDLE_SEARCH);
  const tickets = useRef(0);
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(pause.current);
    },
    [],
  );

  // Every search takes the next ticket; only the latest one's answer shows.
  const run = (text: string, narrowed: SearchQualifiers) => {
    clearTimeout(pause.current);
    tickets.current += 1;
    const ticket = tickets.current;
    if (searchText(text) === "") {
      dispatch({ type: "reset", ticket });
      return;
    }
    dispatch({ type: "start", ticket });
    void (async () => {
      const result = await searchStella({
        fetch,
        qualifiers: narrowed,
        query: text,
        source,
      });
      if (Result.isError(result) && result.error._tag === "SignedOutError") {
        end(source);
      }
      dispatch({ type: "answer", result, ticket });
    })();
  };

  const edit = (text: string) => {
    setQuery(text);
    clearTimeout(pause.current);
    if (searchText(text) === "") {
      run(text, qualifiers);
      return;
    }
    pause.current = setTimeout(() => {
      run(text, qualifiers);
    }, SEARCH_DEBOUNCE_MS);
  };

  const clear = () => {
    setQuery("");
    setQualifiers(NO_QUALIFIERS);
    run("", NO_QUALIFIERS);
  };

  const pick = (chip: QualifierChip) => {
    const next = toggleQualifier(qualifiers, chip);
    if (chip.kind === "matter") {
      setMatterNames((names) => new Map(names).set(chip.value, chip.label));
    }
    setQualifiers(next);
    run(query, next);
  };

  const open = (result: SearchResult) => {
    recents.remember(query);
    router.push(searchResultRoute(result));
  };

  const searching = searchText(query) !== "";
  const page = shownPage(view);
  const chips = searching ? qualifierChips(page, qualifiers, matterNames) : [];

  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[screenStyles.screen, { backgroundColor: colors.background }]}
    >
      <View
        className="flex-row items-center gap-3 px-4 pt-2 pb-3"
        style={screenStyles.readable}
      >
        <View className="flex-1 justify-center">
          <Input
            accessibilityLabel={t("placeholder")}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            className="pe-10"
            onChangeText={edit}
            onSubmitEditing={() => {
              recents.remember(query);
              run(query, qualifiers);
            }}
            placeholder={t("placeholder")}
            returnKeyType="search"
            type="search"
            value={query}
          />
          {query === "" ? null : (
            <Pressable
              accessibilityLabel={t("clear")}
              accessibilityRole="button"
              className="absolute end-0 size-10 items-center justify-center active:opacity-60"
              onPress={clear}
            >
              <XIcon color={ui.mutedForeground} size={16} />
            </Pressable>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          className="active:opacity-60"
          hitSlop={8}
          onPress={() => {
            router.back();
          }}
        >
          <Text variant="label">{t("cancel")}</Text>
        </Pressable>
      </View>
      {chips.length === 0 ? null : (
        <QualifierChips chips={chips} onPick={pick} />
      )}
      {searching ? (
        <SearchResults
          onOpen={open}
          onRetry={() => {
            run(query, qualifiers);
          }}
          query={searchText(query)}
          view={view}
        />
      ) : (
        <RecentSearches
          onClear={recents.clear}
          onRun={(recent) => {
            setQuery(recent);
            recents.remember(recent);
            run(recent, qualifiers);
          }}
          searches={recents.searches}
        />
      )}
    </SafeAreaView>
  );
};

/** The chips that narrow the search, in one row that scrolls sideways. */
const QualifierChips = ({
  chips,
  onPick,
}: {
  chips: readonly QualifierChip[];
  onPick: (chip: QualifierChip) => void;
}) => {
  const t = useTranslations("search");
  const ui = useUiColors();

  return (
    <View accessibilityLabel={t("filters")} className="pb-3">
      <ScrollView
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {chips.map((chip) => (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: chip.picked }}
            className={`rounded-full border px-3 py-1.5 active:opacity-60 ${
              chip.picked
                ? "border-foreground bg-foreground"
                : "border-border bg-card"
            }`}
            key={`${chip.kind}:${chip.value}`}
            onPress={() => {
              onPick(chip);
            }}
          >
            <Text
              numberOfLines={1}
              style={chip.picked ? { color: ui.background } : undefined}
              variant="label"
            >
              {chip.kind === "type"
                ? t(`type.${TYPE_LABELS[chip.value]}`)
                : chip.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
};

/** The recent searches, newest first, each searched again on a tap. */
const RecentSearches = ({
  onClear,
  onRun,
  searches,
}: {
  onClear: () => void;
  onRun: (query: string) => void;
  searches: readonly string[];
}) => {
  const t = useTranslations("search");
  const ui = useUiColors();

  if (searches.length === 0) {
    return (
      <View className="px-4 pt-4" style={screenStyles.readable}>
        <Text variant="caption">{t("hint")}</Text>
      </View>
    );
  }
  return (
    <FlatList
      contentContainerStyle={[screenStyles.readable, { paddingHorizontal: 16 }]}
      data={searches}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      keyExtractor={(search) => search}
      ListHeaderComponent={
        <View className="flex-row items-center justify-between pt-2 pb-1">
          <Text accessibilityRole="header" variant="section">
            {t("recent")}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="active:opacity-60"
            hitSlop={8}
            onPress={onClear}
          >
            <Text variant="label">{t("clearRecent")}</Text>
          </Pressable>
        </View>
      }
      renderItem={({ item: search }) => (
        <Pressable
          accessibilityRole="button"
          className="border-border active:bg-accent flex-row items-center gap-3 border-b py-3"
          onPress={() => {
            onRun(search);
          }}
        >
          <HistoryIcon color={ui.mutedForeground} size={18} />
          <Text className="flex-1" numberOfLines={1} variant="rowTitle">
            {search}
          </Text>
        </Pressable>
      )}
    />
  );
};

/** The results of the latest search, or why there are none. */
const SearchResults = ({
  onOpen,
  onRetry,
  query,
  view,
}: {
  onOpen: (result: SearchResult) => void;
  onRetry: () => void;
  query: string;
  view: SearchView;
}) => {
  const t = useTranslations("search");
  const colors = useAppColors();
  const page = shownPage(view);

  if (view.status === "failed") {
    return (
      <View className="px-4" style={screenStyles.readable}>
        <LoadFailedCard
          error={view.error}
          onRetry={onRetry}
          retryLabel={t("retry")}
          title={t("loadFailed")}
        />
      </View>
    );
  }
  if (page === null) {
    return <ActivityIndicator className="flex-1" color={colors.muted} />;
  }
  if (page.results.length === 0 && view.status === "loaded") {
    return (
      <View className="px-4" style={screenStyles.readable}>
        <EmptyCard
          description={t("noResults", { query })}
          title={t("noResultsTitle")}
        />
      </View>
    );
  }
  return (
    <FlatList
      contentContainerStyle={[screenStyles.readable, { paddingHorizontal: 16 }]}
      data={page.results}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      keyExtractor={(result) => result.key}
      ListHeaderComponent={
        view.status === "loading" ? (
          <ActivityIndicator className="py-2" color={colors.muted} />
        ) : undefined
      }
      renderItem={({ item: result }) => (
        <SearchResultRow
          onPress={() => {
            onOpen(result);
          }}
          result={result}
        />
      )}
    />
  );
};

/**
 * One result in the row its kind has elsewhere: a decision as the case-law
 * list shows it, anything else as a matter's list shows its items, with
 * the matter it sits in named first.
 */
const SearchResultRow = ({
  onPress,
  result,
}: {
  onPress: () => void;
  result: SearchResult;
}) => {
  if (result.kind === "case-law") {
    return (
      <DecisionRow
        decision={{
          caseNumber: result.caseNumber,
          court: result.court,
          decisionDate: result.decisionDate,
          decisionType: null,
          id: result.decisionId,
          preview: result.preview,
        }}
        onPress={onPress}
      />
    );
  }
  const kind = result.kind === "entity" ? result.entityKind : result.kind;
  return (
    <EntityRow
      context={result.kind === "matter" ? null : result.matterName}
      depth={0}
      entity={{
        createdAt: result.updatedAt,
        createdBy: null,
        entityId: idOf(result),
        kind,
        name: result.title,
        parentId: null,
        status: null,
        updatedAt: result.updatedAt,
      }}
      folder={null}
      onPress={onPress}
    />
  );
};

/** The id of what a result stands for: the item, the matter or the thread. */
const idOf = (result: Exclude<SearchResult, { kind: "case-law" }>): string => {
  if (result.kind === "entity") {
    return result.entityId;
  }
  return result.kind === "matter" ? result.workspaceId : result.threadId;
};

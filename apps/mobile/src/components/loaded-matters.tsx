import { use } from "react";

import { Result } from "better-result";
import { FlatList, Pressable, RefreshControl, SectionList } from "react-native";
import { useLocale, useTranslations } from "use-intl";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { useHeaderSearch } from "@/components/header-search";
import { MatterRow } from "@/components/matter-row";
import { useMattersView } from "@/components/matters-view";
import { RetryButton } from "@/components/retry-button";
import { Text } from "@/components/ui/text";
import { ChevronDownIcon, ChevronRightIcon } from "@/icons.gen";
import type { MattersLoad, MatterSummary } from "@/state/matters";
import { groupByClient } from "@/state/matters-groups";
import { useAppColors } from "@/theme";

/**
 * The matters a load returned, or why it could not, with pull-to-refresh
 * either way; under their clients unless the header's menu says otherwise.
 * A client's heading folds its matters away; a search shows every match,
 * folded or not.
 */
export const LoadedMatters = ({
  load,
  onReload,
  refreshing,
}: {
  load: Promise<MattersLoad>;
  onReload: () => void;
  refreshing: boolean;
}) => {
  const t = useTranslations("matters");
  const { query } = useHeaderSearch();
  const { collapsed, groupBy, toggleGroup } = useMattersView();
  const locale = useLocale();
  const colors = useAppColors();
  const { result } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  const matters = Result.isOk(result) ? matching(result.value, query) : [];
  const searching = query.trim() !== "";
  const empty = Result.isOk(result) ? (
    <EmptyCard description={t("emptyDescription")} title={t("emptyTitle")} />
  ) : (
    <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
      <RetryButton label={t("retry")} onPress={onReload} />
    </EmptyCard>
  );
  const refreshControl = (
    <RefreshControl
      onRefresh={onReload}
      refreshing={refreshing}
      tintColor={colors.muted}
    />
  );

  if (groupBy === "client") {
    return (
      <SectionList
        contentContainerStyle={screenStyles.content}
        // The header is the platform's translucent bar; the list scrolls under it.
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(matter) => matter.id}
        ListEmptyComponent={empty}
        refreshControl={refreshControl}
        renderItem={({ item, section }) => (
          <MatterRow matter={item} underClient={section.client !== null} />
        )}
        renderSectionHeader={({ section }) => {
          const open = searching || !collapsed.has(section.key);
          const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              className="flex-row items-center gap-2 pt-6 pb-1 active:opacity-60"
              disabled={searching}
              onPress={() => {
                toggleGroup(section.key);
              }}
            >
              <Text className="flex-1" numberOfLines={1} variant="headline">
                {section.client ?? t("personal")}
              </Text>
              <Text variant="caption">{section.count}</Text>
              <Chevron color={colors.muted} size={18} />
            </Pressable>
          );
        }}
        sections={groupByClient(matters, locale).map(
          ({ client, data, key }) => ({
            client,
            count: data.length,
            data: searching || !collapsed.has(key) ? data : [],
            key,
          }),
        )}
        stickySectionHeadersEnabled={false}
      />
    );
  }
  return (
    <FlatList
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={matters}
      keyExtractor={(matter) => matter.id}
      ListEmptyComponent={empty}
      refreshControl={refreshControl}
      renderItem={({ item }) => <MatterRow matter={item} />}
    />
  );
};

/** The matters whose name, reference or client contains what was searched for. */
function matching(
  matters: readonly MatterSummary[],
  query: string,
): readonly MatterSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") {
    return matters;
  }
  return matters.filter((matter) =>
    [matter.name, matter.reference, matter.client?.displayName].some(
      (field) => field?.toLocaleLowerCase().includes(needle) === true,
    ),
  );
}

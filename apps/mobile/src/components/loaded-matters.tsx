import { use } from "react";

import { Result } from "better-result";
import { FlatList, RefreshControl, SectionList, View } from "react-native";
import { useLocale, useTranslations } from "use-intl";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { useHeaderSearch } from "@/components/header-search";
import { MatterRow } from "@/components/matter-row";
import { useMattersView } from "@/components/matters-view";
import { RetryButton } from "@/components/retry-button";
import { Text } from "@/components/ui/text";
import type { MattersLoad, MatterSummary } from "@/state/matters";
import { groupByClient } from "@/state/matters-groups";
import { useAppColors } from "@/theme";

/**
 * The matters a load returned, or why it could not, with pull-to-refresh
 * either way; under their clients unless the header's menu says otherwise.
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
  const { groupBy } = useMattersView();
  const locale = useLocale();
  const colors = useAppColors();
  const { result } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  const matters = Result.isOk(result) ? matching(result.value, query) : [];
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
        renderSectionHeader={({ section }) => (
          <View className="pt-4 pb-1">
            <Text variant="section">{section.client ?? t("personal")}</Text>
          </View>
        )}
        sections={groupByClient(matters, locale)}
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

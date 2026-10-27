import { use } from "react";

import { Result } from "better-result";
import { FlatList, RefreshControl } from "react-native";
import { useTranslations } from "use-intl";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { useHeaderSearch } from "@/components/header-search";
import { MatterRow } from "@/components/matter-row";
import { RetryButton } from "@/components/retry-button";
import type { MattersLoad, MatterSummary } from "@/state/matters";
import { useAppColors } from "@/theme";

/** The matters a load returned, or why it could not, with pull-to-refresh either way. */
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
  const colors = useAppColors();
  const { result } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  return (
    <FlatList
      contentContainerStyle={screenStyles.content}
      // The header is the platform's translucent bar; the list scrolls under it.
      contentInsetAdjustmentBehavior="automatic"
      data={Result.isOk(result) ? matching(result.value, query) : []}
      keyExtractor={(matter) => matter.id}
      ListEmptyComponent={
        Result.isOk(result) ? (
          <EmptyCard
            description={t("emptyDescription")}
            title={t("emptyTitle")}
          />
        ) : (
          <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
            <RetryButton label={t("retry")} onPress={onReload} />
          </EmptyCard>
        )
      }
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
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

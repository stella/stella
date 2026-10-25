import { use } from "react";

import { Result } from "better-result";
import { FlatList, RefreshControl } from "react-native";
import { useTranslations } from "use-intl";

import {
  EmptyCard,
  ScreenHeading,
  screenStyles,
} from "@/components/empty-state-screen";
import { MatterRow } from "@/components/matter-row";
import { RetryButton } from "@/components/retry-button";
import type { MattersLoad } from "@/state/matters";
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
  const tabs = useTranslations("tabs");
  const colors = useAppColors();
  const { loadedAt, result } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  return (
    <FlatList
      contentContainerStyle={screenStyles.content}
      data={Result.isOk(result) ? result.value : []}
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
      ListHeaderComponent={
        <ScreenHeading description={t("description")} title={tabs("matters")} />
      }
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item }) => <MatterRow loadedAt={loadedAt} matter={item} />}
    />
  );
};

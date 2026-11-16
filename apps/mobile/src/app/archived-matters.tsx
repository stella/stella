import { Suspense, use, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useTranslations } from "use-intl";

import { MatterIcon } from "@stll/ui/matter-icon";
import { Text } from "@stll/ui/text";

import { useRevisedLoad } from "@/components/changes";
import { EmptyCard, emptyListProps } from "@/components/empty-state-screen";
import { LoadFailedCard } from "@/components/load-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { listMatters } from "@/state/matters";
import type { MatterSummary } from "@/state/matters";
import { useAppColors } from "@/theme";

type ArchivedLoad = Promise<Result<MatterSummary[], ApiError>>;

/**
 * The person's archived matters, as the web's matters list shows them under
 * its archived filter. One opens as any matter does, where its details can
 * restore it.
 */
const ArchivedMattersScreen = () => {
  const t = useTranslations("matters");
  const { state } = useSession();
  return (
    <>
      <Stack.Screen options={{ title: t("archivedMatters") }} />
      {state.status === "signed-in" ? (
        <ArchivedMatters source={state.source} />
      ) : null}
    </>
  );
};

const ArchivedMatters = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { end } = useSession();
  const load = async () => {
    const result = await listMatters({ fetch, source, status: "archived" });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  };
  const [archived, setArchived] = useRevisedLoad(load, ["matters"]);
  const [refreshing, startRefresh] = useTransition();
  return (
    <Suspense
      fallback={<ActivityIndicator className="flex-1" color={colors.muted} />}
    >
      <LoadedArchived
        load={archived}
        onReload={() => {
          startRefresh(() => {
            setArchived(load());
          });
        }}
        refreshing={refreshing}
      />
    </Suspense>
  );
};

const LoadedArchived = ({
  load,
  onReload,
  refreshing,
}: {
  load: ArchivedLoad;
  onReload: () => void;
  refreshing: boolean;
}) => {
  const t = useTranslations("matters");
  const colors = useAppColors();
  const router = useRouter();
  const result = use(load);
  const matters = Result.isOk(result) ? result.value : [];

  return (
    <FlatList
      {...emptyListProps(matters.length === 0)}
      ListEmptyComponent={
        Result.isOk(result) ? (
          <EmptyCard
            description={t("archivedEmpty")}
            title={t("archivedMatters")}
          />
        ) : (
          <LoadFailedCard
            error={result.error}
            onRetry={onReload}
            retryLabel={t("retry")}
            title={t("loadFailed")}
          />
        )
      }
      contentInsetAdjustmentBehavior="automatic"
      data={matters}
      keyExtractor={(matter) => matter.id}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item: matter }) => (
        <Pressable
          accessibilityRole="button"
          className="border-border active:bg-accent flex-row items-center gap-3 border-b px-4 py-3"
          onPress={() => {
            router.push({
              pathname: "/matter/[workspaceId]",
              params: { name: matter.name, workspaceId: matter.id },
            });
          }}
        >
          <MatterIcon matter={matter} size={18} />
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={1} variant="rowTitle">
              {matter.name}
            </Text>
            {matter.client?.displayName !== undefined ? (
              <Text numberOfLines={1} variant="caption">
                {matter.client.displayName}
              </Text>
            ) : null}
          </View>
        </Pressable>
      )}
    />
  );
};

export default ArchivedMattersScreen;

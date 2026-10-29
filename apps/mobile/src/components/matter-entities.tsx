import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import { useRouter } from "expo-router";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { EntityRow } from "@/components/entity-row";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import {
  applyEntityPage,
  EMPTY_ENTITIES_LOAD,
  entitySections,
  listMatterEntities,
} from "@/state/matter-entities";
import type { EntitiesLoad } from "@/state/matter-entities";
import { useAppColors } from "@/theme";

/**
 * A matter's documents and tasks: the first page on open and on every pull
 * to refresh, the next page on "load more".
 */
export const MatterEntities = ({
  source,
  workspaceId,
}: {
  source: AccessTokenSource;
  workspaceId: string;
}) => {
  const { end } = useSession();
  // A session the server ended sends the person back to sign in, from the
  // load itself rather than from a render.
  const loadPage = async (previous: EntitiesLoad): Promise<EntitiesLoad> => {
    const result = await listMatterEntities({
      fetch,
      source,
      workspaceId,
      cursor: previous.nextCursor,
    });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return applyEntityPage(previous, result, epochMilliseconds());
  };
  const [load, setLoad] = useState(async () => loadPage(EMPTY_ENTITIES_LOAD));
  const [refreshing, startRefresh] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadPage(EMPTY_ENTITIES_LOAD));
    });
  };
  const loadMore = (current: EntitiesLoad) => {
    startLoadMore(() => {
      setLoad(loadPage(current));
    });
  };

  return (
    <Suspense fallback={<Loader style={styles.loading} />}>
      <LoadedEntities
        load={load}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        onReload={reload}
        refreshing={refreshing}
        workspaceId={workspaceId}
      />
    </Suspense>
  );
};

const LoadedEntities = ({
  load,
  loadingMore,
  onLoadMore,
  onReload,
  refreshing,
  workspaceId,
}: {
  load: Promise<EntitiesLoad>;
  loadingMore: boolean;
  onLoadMore: (current: EntitiesLoad) => void;
  onReload: () => void;
  refreshing: boolean;
  workspaceId: string;
}) => {
  const t = useTranslations("matter");
  const colors = useAppColors();
  const router = useRouter();
  const current = use(load);

  // The session provider is already returning to sign-in.
  if (current.error?._tag === "SignedOutError") {
    return null;
  }

  const firstPageFailed =
    current.error !== null && current.entities.length === 0;
  const retryButton = (onPress: () => void) => (
    <Button
      className="self-start"
      onPress={onPress}
      size="sm"
      variant="outline"
    >
      {t("retry")}
    </Button>
  );

  const footer = (() => {
    if (current.entities.length === 0) {
      return null;
    }
    if (loadingMore) {
      return <Loader style={styles.footer} />;
    }
    if (current.error !== null) {
      return (
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.muted }]}>
            {t("loadMoreFailed")}
          </Text>
          {retryButton(() => {
            onLoadMore(current);
          })}
        </View>
      );
    }
    if (current.nextCursor === null) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button
          className="self-start"
          onPress={() => {
            onLoadMore(current);
          }}
          size="sm"
          variant="outline"
        >
          {t("loadMore")}
        </Button>
      </View>
    );
  })();

  return (
    <SectionList
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyExtractor={(entity) => entity.entityId}
      ListEmptyComponent={
        firstPageFailed ? (
          <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
            {retryButton(onReload)}
          </EmptyCard>
        ) : (
          <EmptyCard
            description={t("emptyDescription")}
            title={t("emptyTitle")}
          />
        )
      }
      ListFooterComponent={footer ?? undefined}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item }) => (
        <EntityRow
          entity={item}
          onPress={() => {
            router.push({
              pathname: "/matter/[workspaceId]/[entityId]",
              params: { workspaceId, entityId: item.entityId },
            });
          }}
        />
      )}
      renderSectionHeader={({ section }) => (
        <Text
          accessibilityRole="header"
          style={[styles.sectionHeader, { color: colors.muted }]}
        >
          {t(section.key)}
        </Text>
      )}
      sections={entitySections(current.entities)}
      stickySectionHeadersEnabled={false}
    />
  );
};

const styles = StyleSheet.create({
  content: {
    ...screenStyles.readable,
    paddingBottom: 32,
    paddingHorizontal: 20,
  },
  footer: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
  },
  footerText: {
    fontSize: 14,
  },
  loading: {
    flex: 1,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.4,
    paddingBottom: 8,
    paddingTop: 20,
    textTransform: "uppercase",
  },
});

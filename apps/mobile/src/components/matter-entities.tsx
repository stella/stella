import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { EntityRow } from "@/components/entity-row";
import { LoadFailedCard } from "@/components/load-failure";
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
  const colors = useAppColors();
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
    <Suspense
      fallback={
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      }
    >
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
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleFolder = (folderId: string) => {
    setOpenFolders((open) => {
      const next = new Set(open);
      if (!next.delete(folderId)) {
        next.add(folderId);
      }
      return next;
    });
  };

  // The session provider is already returning to sign-in.
  if (current.error?._tag === "SignedOutError") {
    return null;
  }

  const retryButton = (onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.button, { borderColor: colors.border }]}
    >
      <Text style={[styles.buttonLabel, { color: colors.accent }]}>
        {t("retry")}
      </Text>
    </Pressable>
  );

  const footer = (() => {
    if (current.entities.length === 0) {
      return null;
    }
    if (loadingMore) {
      return <ActivityIndicator color={colors.accent} style={styles.footer} />;
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
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onLoadMore(current);
          }}
          style={[styles.button, { borderColor: colors.border }]}
        >
          <Text style={[styles.buttonLabel, { color: colors.accent }]}>
            {t("loadMore")}
          </Text>
        </Pressable>
      </View>
    );
  })();

  return (
    <SectionList
      // An empty matter holds only its card, which fits: nothing to bounce.
      alwaysBounceVertical={current.entities.length > 0}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyExtractor={(tree) => tree.entity.entityId}
      ListEmptyComponent={
        current.error !== null && current.entities.length === 0 ? (
          <LoadFailedCard
            error={current.error}
            onRetry={onReload}
            retryLabel={t("retry")}
            title={t("loadFailed")}
          />
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
      renderItem={({ item: tree }) => (
        <EntityRow
          depth={tree.depth}
          entity={tree.entity}
          folder={tree.type === "folder" ? { open: tree.open } : null}
          onPress={() => {
            const item = tree.entity;
            // A folder opens and closes in place, as on the web; a document
            // opens to its pages; a task to its details.
            if (tree.type === "folder") {
              toggleFolder(item.entityId);
              return;
            }
            if (item.kind === "document") {
              router.push({
                pathname: "/document/[workspaceId]/[entityId]",
                params: {
                  workspaceId,
                  entityId: item.entityId,
                  ...(item.name === null ? {} : { name: item.name }),
                },
              });
              return;
            }
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
      sections={entitySections(current.entities, openFolders)}
      stickySectionHeadersEnabled={false}
    />
  );
};

const styles = StyleSheet.create({
  button: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
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

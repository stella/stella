import { useMemo, useRef, useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  KanbanIcon,
  PencilIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { TASK_STATUSES, VIEW_SORTS_MAX } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { ViewToolbarChrome } from "@stll/ui/view-toolbar";
import { SortChips } from "@stll/workspace-ui/sorts";
import { WorkspaceViewSwitcher } from "@stll/workspace-ui/view-switcher";

import { InlineEdit } from "@/components/inline-edit";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useLocale } from "@/i18n/formatting-context";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import {
  entityViewKeys,
  entityViewRowsOptions,
  entityViewsOptions,
} from "@/lib/entity-views/queries";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  DEFAULT_INBOX_FILTERS,
  INBOX_VIEWS,
  inboxKeys,
  inboxSignalsOptions,
} from "@/lib/inbox/queries";
import type { InboxView } from "@/lib/inbox/queries";
import { toSafeId } from "@/lib/safe-id";
import type { ViewLayout, WorkspaceView } from "@/lib/types";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { isTableView, mergeLayout } from "@/lib/workspaces/view-layout";
import {
  GroupByControl,
  KanbanGroupingSettings,
} from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar";
import { FilterChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-filters";

import { defaultEntityViews } from "./defaults";
import { EntityViewKanban } from "./kanban";
import {
  ENTITY_VIEW_GROUP,
  proposalMatchesFilters,
  sortEntityViewEntries,
  toEntityViewRow,
} from "./model";
import {
  EntityViewColumnToggle,
  EntityViewTable,
  useEntityViewSortProperties,
} from "./table";
import type { EntityViewScope } from "./types";

const isUnsavedViewId = (id: string) =>
  id.startsWith("default:") || id.startsWith("draft:");

type EntityViewsProps = { organizationId: string; scope: EntityViewScope };

export const EntityViews = ({ organizationId, scope }: EntityViewsProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const direction = useI18nStore((state) => getLangDir(state.lang));
  const saved = useQuery(entityViewsOptions(organizationId));
  const sortProperties = useEntityViewSortProperties();
  const canCreateView = usePermissions({ view: ["create"] });
  const canUpdateView = usePermissions({ view: ["update"] });
  const canDeleteView = usePermissions({ view: ["delete"] });
  const savedIds = useRef(new Map<string, string>());
  const latestSave = useRef(0);
  useExternalSyncEffect(() => {
    if (saved.error) analytics.captureError(saved.error);
  }, [analytics, saved.error]);
  const defaults = useMemo(
    () =>
      defaultEntityViews({
        table: t("workspaces.views.layouts.table"),
        kanban: t("workspaces.views.layouts.kanban"),
      }),
    [t],
  );
  const savedViews = saved.data?.items ?? [];
  const views = [
    ...savedViews,
    ...defaults.filter(
      (view) =>
        !savedViews.some(
          (savedView) => savedView.layout.type === view.layout.type,
        ),
    ),
  ];
  const [selectedId, setSelectedId] = useState("default:kanban");
  const [proposalView, setProposalView] = useState<InboxView>("open");
  const [draft, setDraft] = useState<WorkspaceView | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const activeView =
    draft?.id === selectedId
      ? draft
      : (views.find((view) => view.id === selectedId) ?? views.at(0));
  const reportError = (error: unknown) => {
    analytics.captureError(error);
    stellaToast.error(userErrorFromThrown(error, t("common.unexpectedError")));
  };
  const save = useMutation({
    scope: { id: `entity-views:${organizationId}` },
    mutationFn: async (view: WorkspaceView) => {
      const id = savedIds.current.get(view.id) ?? view.id;
      const result = isUnsavedViewId(id)
        ? unwrapEden(
            await api["entity-views"].put({
              name: view.name,
              layout: view.layout,
            }),
          )
        : unwrapEden(
            await api["entity-views"]({
              viewId: toSafeId<"workspaceView">(id),
            }).patch({ name: view.name, layout: view.layout }),
          );
      savedIds.current.set(view.id, result.id);
      return result;
    },
    onMutate: (view) => {
      const sequence = ++latestSave.current;
      setDraft(view);
      return { sequence };
    },
    onSuccess: async (view, submitted, context) => {
      await queryClient.invalidateQueries(entityViewsOptions(organizationId));
      if (context?.sequence !== latestSave.current) return;
      setSelectedId((current) =>
        current === submitted.id ? view.id : current,
      );
      setDraft(null);
    },
    onError: (error, _view, context) => {
      if (context?.sequence === latestSave.current) setDraft(null);
      reportError(error);
    },
  });
  const remove = useMutation({
    scope: { id: `entity-views:${organizationId}` },
    mutationFn: async (viewId: string) =>
      unwrapEden(
        await api["entity-views"]({
          viewId: toSafeId<"workspaceView">(viewId),
        }).delete(),
      ),
    onSuccess: async (_result, removedId) => {
      for (const [temporaryId, serverId] of savedIds.current) {
        if (serverId === removedId) savedIds.current.delete(temporaryId);
      }
      await queryClient.invalidateQueries(entityViewsOptions(organizationId));
      setSelectedId("default:kanban");
    },
    onError: reportError,
  });
  const reorder = useMutation({
    mutationFn: async (viewIds: string[]) =>
      unwrapEden(
        await api["entity-views"].reorder.post({
          viewIds: viewIds.map((id) => toSafeId<"workspaceView">(id)),
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries(entityViewsOptions(organizationId)),
    onError: reportError,
  });
  if (saved.isPending || !activeView) return <EntityViewsPending />;
  if (saved.error)
    return (
      <div className="p-4 text-sm">
        <p>{userErrorFromThrown(saved.error, t("common.unexpectedError"))}</p>
        <Button onClick={() => detached(saved.refetch(), "entity-views.retry")}>
          {t("common.retry")}
        </Button>
      </div>
    );
  const canEditView = isUnsavedViewId(activeView.id)
    ? canCreateView
    : canUpdateView;
  const persist = (view: WorkspaceView) => {
    if (isUnsavedViewId(view.id) ? !canCreateView : !canUpdateView) return;
    setSelectedId(view.id);
    save.mutate(view);
  };
  const onLayoutChange = (layout: ViewLayout) => {
    if (canEditView) persist({ ...activeView, layout });
  };
  const groups = [
    { id: ENTITY_VIEW_GROUP.TYPE, label: t("common.type") },
    { id: ENTITY_VIEW_GROUP.MATTER, label: t("common.matter") },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t">
      <fieldset
        disabled={remove.isPending}
        className="flex min-w-0 flex-wrap items-center border-b"
      >
        <WorkspaceViewSwitcher
          activeViewId={activeView.id}
          ariaLabel={t("workspaces.views.viewSettings")}
          direction={direction}
          views={views}
          reorder={
            canUpdateView &&
            views.every((view) => !view.id.startsWith("default:"))
              ? {
                  onReorder: (ids) => reorder.mutate(ids),
                  isBlocked: reorder.isPending,
                }
              : null
          }
          onViewChange={(id) => {
            setSelectedId(id);
            setDraft(null);
          }}
          onViewDoubleClick={(view) => {
            if (isUnsavedViewId(view.id) ? canCreateView : canUpdateView)
              setEditing({ id: view.id, name: view.name });
          }}
          renderIcon={(view) =>
            view.layout.type === "table" ? (
              <TableIcon className="size-3.5" />
            ) : (
              <KanbanIcon className="size-3.5" />
            )
          }
          editing={
            editing
              ? {
                  viewId: editing.id,
                  renderLabel: (view) => (
                    <InlineEdit
                      value={editing.name}
                      onChange={(name) => setEditing({ id: view.id, name })}
                      onCancel={() => setEditing(null)}
                      onCommit={() => {
                        if (editing.name.trim())
                          persist({ ...view, name: editing.name.trim() });
                        setEditing(null);
                      }}
                    />
                  ),
                }
              : null
          }
          actionMenu={{
            label: t("common.actions"),
            renderItems: (view) => (
              <>
                <MenuItem
                  disabled={
                    isUnsavedViewId(view.id) ? !canCreateView : !canUpdateView
                  }
                  onClick={() => setEditing({ id: view.id, name: view.name })}
                >
                  <PencilIcon className="size-3.5" />
                  {t("common.rename")}
                </MenuItem>
                {canDeleteView && !isUnsavedViewId(view.id) && (
                  <MenuItem onClick={() => remove.mutate(view.id)}>
                    <Trash2Icon className="size-3.5" />
                    {t("workspaces.views.deleteView")}
                  </MenuItem>
                )}
              </>
            ),
          }}
          addControl={
            canCreateView ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("common.add")}
                    />
                  }
                >
                  <PlusIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup>
                  {defaults.map((view) => (
                    <MenuItem
                      key={view.id}
                      onClick={() =>
                        persist({ ...view, id: `draft:${crypto.randomUUID()}` })
                      }
                    >
                      {t("workspaces.views.newView", {
                        layoutType: view.layout.type,
                        layout: view.name,
                      })}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null
          }
        />
        <ViewToolbarChrome className="md:ms-auto md:justify-end">
          <Select onValueChange={setProposalView} value={proposalView}>
            <SelectTrigger
              aria-label={t("inbox.proposalView", {
                view: t(
                  proposalView === "open"
                    ? "common.open"
                    : `inbox.view.${proposalView}`,
                ),
              })}
              size="sm"
            >
              <SelectValue>
                {t("inbox.proposalView", {
                  view: t(
                    proposalView === "open"
                      ? "common.open"
                      : `inbox.view.${proposalView}`,
                  ),
                })}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {INBOX_VIEWS.map((view) => (
                <SelectItem key={view} value={view}>
                  {t(view === "open" ? "common.open" : `inbox.view.${view}`)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <fieldset disabled={!canEditView} className="contents">
            <FilterChips
              filters={activeView.layout.filters}
              properties={[]}
              onUpdate={(filters) =>
                onLayoutChange(mergeLayout(activeView.layout, { filters }))
              }
            />
            <SortChips
              sorts={activeView.layout.sorts}
              properties={sortProperties}
              maxSorts={VIEW_SORTS_MAX}
              labels={{ add: t("common.add"), remove: t("common.remove") }}
              onUpdate={(sorts) =>
                onLayoutChange(mergeLayout(activeView.layout, { sorts }))
              }
            />
            {activeView.layout.type === "kanban" && (
              <KanbanGroupingSettings
                properties={[]}
                allowAssigneeGrouping
                additionalSubgroups={groups}
                groupByPropertyId={activeView.layout.groupByPropertyId}
                subgroupByPropertyId={activeView.layout.subgroupByPropertyId}
                onChange={(groupByPropertyId, subgroupByPropertyId) => {
                  if (activeView.layout.type === "kanban")
                    onLayoutChange(
                      mergeLayout(activeView.layout, {
                        groupByPropertyId,
                        subgroupByPropertyId,
                      }),
                    );
                }}
              />
            )}
            {isTableView(activeView) && (
              <EntityViewColumnToggle
                view={activeView}
                onLayoutChange={onLayoutChange}
              />
            )}
            {activeView.layout.type === "table" && (
              <GroupByControl
                properties={[]}
                additionalGroups={groups}
                allowNone
                allowAssigneeGrouping
                allowCreatedByGrouping
                groupByPropertyId={activeView.layout.groupByPropertyId}
                onChange={(groupByPropertyId) => {
                  if (activeView.layout.type === "table")
                    onLayoutChange(
                      mergeLayout(activeView.layout, {
                        groupByPropertyId: groupByPropertyId || undefined,
                      }),
                    );
                }}
              />
            )}
          </fieldset>
        </ViewToolbarChrome>
      </fieldset>
      <EntityViewContent
        organizationId={organizationId}
        proposalView={proposalView}
        scope={scope}
        view={activeView}
        onLayoutChange={onLayoutChange}
      />
    </div>
  );
};

type EntityViewContentProps = EntityViewsProps & {
  proposalView: InboxView;
  view: WorkspaceView;
  onLayoutChange: (layout: ViewLayout) => void;
};
const EntityViewContent = ({
  organizationId,
  proposalView,
  scope,
  view,
  onLayoutChange,
}: EntityViewContentProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const records = useInfiniteQuery(
    entityViewRowsOptions({ organizationId, scope, layout: view.layout }),
  );
  const proposals = useInfiniteQuery(
    inboxSignalsOptions(organizationId, {
      ...DEFAULT_INBOX_FILTERS,
      view: proposalView,
      workspaceId: scope.type === "matter" ? scope.matterId : null,
    }),
  );
  const proposalEntries = useMemo(
    () =>
      proposals.data?.pages
        .flatMap((page) =>
          page.items.map((signal) => ({ type: "proposal" as const, signal })),
        )
        .filter((entry) =>
          proposalMatchesFilters(entry, view.layout.filters),
        ) ?? [],
    [proposals.data, view.layout.filters],
  );
  const entries = useMemo(
    () =>
      sortEntityViewEntries({
        entries: [
          ...proposalEntries,
          ...(records.data?.pages.flatMap((page) => page.items) ?? []),
        ],
        sorts: view.layout.sorts,
        locale,
      }),
    [locale, proposalEntries, records.data, view.layout.sorts],
  );
  const rows = useMemo(() => entries.map(toEntityViewRow), [entries]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: entityViewKeys.all(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: inboxKeys.all(organizationId),
      }),
      ...[
        ...new Set(
          entries.flatMap((entry) =>
            entry.type === "entity" ? [entry.workspaceId] : [],
          ),
        ),
      ].map((workspaceId) =>
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
      ),
    ]);
  };
  const hasNextPage = records.hasNextPage || proposals.hasNextPage;
  const loadingMore =
    records.isFetchingNextPage || proposals.isFetchingNextPage;
  const onLoadMore = () => {
    if (records.hasNextPage && !records.isFetchingNextPage)
      detached(records.fetchNextPage(), "entity-views.more-records");
    if (proposals.hasNextPage && !proposals.isFetchingNextPage)
      detached(proposals.fetchNextPage(), "entity-views.more-proposals");
  };
  useExternalSyncEffect(() => {
    if (records.error) analytics.captureError(records.error);
    if (proposals.error) analytics.captureError(proposals.error);
  }, [analytics, records.error, proposals.error]);
  const loading = records.isPending || proposals.isPending;
  if (loading && !isTableView(view)) return <EntityViewsPending />;
  const error = records.error ?? proposals.error;
  return (
    <>
      {error && (
        <div className="flex items-center gap-2 p-2 text-sm">
          <span>{userErrorFromThrown(error, t("common.unexpectedError"))}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              detached(records.refetch(), "entity-views.retry-records");
              detached(proposals.refetch(), "entity-views.retry-proposals");
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {isTableView(view) ? (
        <EntityViewTable
          rows={rows}
          scope={scope}
          view={view}
          onLayoutChange={onLayoutChange}
          organizationId={organizationId}
          onChanged={refresh}
          loading={loading}
          hasNextPage={hasNextPage}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
      ) : view.layout.type === "kanban" ? (
        <EntityViewKanban
          rows={rows}
          layout={view.layout}
          scope={scope}
          organizationId={organizationId}
          onChanged={refresh}
        />
      ) : null}
      {view.layout.type === "kanban" && hasNextPage && (
        <Button
          className="mx-auto my-2"
          size="sm"
          variant="ghost"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {t(loadingMore ? "common.loading" : "common.loadMore")}
        </Button>
      )}
    </>
  );
};

export const EntityViewsPending = () => (
  <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
    <Skeleton className="h-8 w-72" />
    <div className="flex flex-1 gap-3">
      {[...TASK_STATUSES, "unassigned"].map((key) => (
        <Skeleton key={key} className="min-w-64 flex-1" />
      ))}
    </div>
  </div>
);

import { Suspense, useCallback, useDeferredValue, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import {
  useInfiniteQuery,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { panic, Result } from "better-result";
import {
  BotIcon,
  ChevronDownIcon,
  Clock3Icon,
  DownloadIcon,
  LanguagesIcon,
  ListChecksIcon,
  ListIcon,
  ListFilterIcon,
  ScaleIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { DocumentIcon } from "@/components/document-icon";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterIcon } from "@/components/matter-icon";
import { PersonMentionLabel } from "@/components/person-mention-label";
import Tooltip from "@/components/tooltip";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  FULL_DATE_LONG_TIME_FORMAT,
  MEDIUM_DATE_SHORT_TIME_FORMAT,
} from "@/lib/relative-time";
import { isFileDisplayable } from "@/lib/types";
import { downloadFile } from "@/lib/utils";
import {
  DEFAULT_MATTER_ACTIVITY_FILTERS,
  exportOverviewActivity,
  MATTER_ACTIVITY_ACTIONS,
  MATTER_ACTIVITY_CATEGORIES,
  overviewActivityActorsOptions,
  overviewActivityOptions,
  type MatterActivityActor,
  type MatterActivityAction,
  type MatterActivityCategory,
  type MatterActivityFilters,
  type MatterActivityItem,
} from "@/lib/workspaces/queries";

import type { ActivityGroup } from "./activity-panel.logic";
import {
  activityDayKey,
  expandActivityGroupsForList,
  groupActivityItems,
  resolveVisibleActivityTriggerType,
  resolveSelectedActivityGroup,
  ROW_ACTION_LABEL_KEYS,
  TARGET_LABEL_KEYS,
  toSingleActivityGroup,
  toMatterActivityDateRange,
  toMatterActivityDatePickerValues,
} from "./activity-panel.logic";

type ActivityPanelProps = { workspaceId: string };
type ActivityDay = [ActivityGroup, ...ActivityGroup[]];
type ActivityViewMode = "timeline" | "list";

const groupActivityDays = (groups: ActivityGroup[]): ActivityDay[] => {
  const result = new Map<string, ActivityDay>();
  for (const group of groups) {
    const key = activityDayKey(group.items[0].activityAt);
    const dayGroups = result.get(key);
    if (dayGroups) {
      dayGroups.push(group);
      continue;
    }
    result.set(key, [group]);
  }
  return [...result.values()];
};

const FIRST_STRONG_ISOLATE = String.fromCodePoint(8296);
const POP_DIRECTIONAL_ISOLATE = String.fromCodePoint(8297);
const isolateBidi = (value: string): string =>
  `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`;

const categoryLabelKeys = {
  all: "workspaces.overview.activity.filters.all",
  automation: "workspaces.overview.activity.filters.automation",
  court: "workspaces.overview.activity.filters.court",
  documents: "workspaces.overview.activity.filters.documents",
  matter: "workspaces.overview.activity.filters.matter",
  tasks: "workspaces.overview.activity.filters.tasks",
  team: "workspaces.overview.activity.filters.team",
} as const satisfies Record<MatterActivityCategory, TranslationKey>;

const actionLabelKeys = {
  add: "workspaces.overview.activity.actorActions.added",
  all: "common.all",
  cancel: "workspaces.overview.activity.actorActions.cancelled",
  create: "workspaces.overview.activity.actorActions.created",
  delete: "workspaces.overview.activity.actorActions.deleted",
  execute: "workspaces.overview.activity.actorActions.executed",
  remove: "workspaces.overview.activity.actorActions.removed",
  review: "workspaces.overview.activity.actorActions.reviewed",
  update: "workspaces.overview.activity.actorActions.updated",
} as const satisfies Record<MatterActivityAction, TranslationKey>;

export const ActivityPanel = ({ workspaceId }: ActivityPanelProps) => {
  const t = useTranslations();
  const [filters, setFilters] = useState<MatterActivityFilters>(
    DEFAULT_MATTER_ACTIVITY_FILTERS,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ActivityViewMode>("timeline");
  const deferredFilters = useDeferredValue(filters);
  const { from: fromDate, to: toDate } =
    toMatterActivityDatePickerValues(filters);
  const isFilterPending = filters !== deferredFilters;
  const viewOptions = [
    {
      icon: Clock3Icon,
      label: t("workspaces.overview.activity.views.timeline"),
      value: "timeline",
    },
    {
      icon: ListIcon,
      label: t("workspaces.overview.activity.views.list"),
      value: "list",
    },
  ] as const;

  return (
    <section aria-labelledby="matter-activity-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-muted-foreground text-sm font-medium"
          id="matter-activity-heading"
        >
          {t("workspaces.overview.activity.title")}
        </h2>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SegmentedIconToggle
            onChange={setViewMode}
            options={viewOptions}
            size="touch"
            value={viewMode}
          />
          <ActivityAdvancedFilters
            filters={filters}
            fromDate={fromDate}
            onFiltersChange={(nextFilters) => {
              setSelectedGroupId(null);
              setFilters(nextFilters);
            }}
            onFromDateChange={(value) => {
              const range = toMatterActivityDateRange({
                from: value,
                to: toDate,
              });
              setSelectedGroupId(null);
              setFilters((current) => ({ ...current, ...range }));
            }}
            onToDateChange={(value) => {
              const range = toMatterActivityDateRange({
                from: fromDate,
                to: value,
              });
              setSelectedGroupId(null);
              setFilters((current) => ({ ...current, ...range }));
            }}
            toDate={toDate}
            workspaceId={workspaceId}
          />
          <ActivityExportMenu filters={filters} workspaceId={workspaceId} />
          <Menu>
            <MenuTrigger
              aria-label={t("workspaces.overview.activity.filterLabel")}
              className="h-7 gap-1.5 text-xs [@media(any-pointer:coarse)]:h-11"
              render={<Button size="sm" variant="ghost" />}
            >
              <ListFilterIcon className="size-3.5" />
              {t(categoryLabelKeys[filters.category])}
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuRadioGroup value={filters.category}>
                {MATTER_ACTIVITY_CATEGORIES.map((value) => (
                  <MenuRadioItem
                    key={value}
                    onClick={() => {
                      setSelectedGroupId(null);
                      setFilters((current) => ({
                        ...current,
                        category: value,
                      }));
                    }}
                    value={value}
                  >
                    {t(categoryLabelKeys[value])}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      </div>

      <div
        aria-busy={isFilterPending}
        className={cn(
          isFilterPending
            ? "opacity-60 transition-opacity duration-150"
            : "opacity-100 transition-opacity duration-150",
        )}
      >
        <Suspense fallback={<ActivityTimelineSkeleton />}>
          <ActivityTimeline
            filters={deferredFilters}
            onSelectedGroupChange={setSelectedGroupId}
            selectedGroupId={selectedGroupId}
            viewMode={viewMode}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>
    </section>
  );
};

const ActivityAdvancedFilters = ({
  filters,
  fromDate,
  onFiltersChange,
  onFromDateChange,
  onToDateChange,
  toDate,
  workspaceId,
}: {
  filters: MatterActivityFilters;
  fromDate: string | null;
  onFiltersChange: (filters: MatterActivityFilters) => void;
  onFromDateChange: (value: string | null) => void;
  onToDateChange: (value: string | null) => void;
  toDate: string | null;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [actorSearch, setActorSearch] = useState("");
  const [selectedActorDetails, setSelectedActorDetails] =
    useState<MatterActivityActor | null>(null);
  const debouncedSetActorSearch = useDebouncedCallback(setActorSearch, 300);
  const actorsQuery = useInfiniteQuery({
    ...overviewActivityActorsOptions(workspaceId, actorSearch),
    enabled: open,
  });
  const actors = actorsQuery.data
    ? actorsQuery.data.pages.flatMap((page) => page.items)
    : [];
  const selectedActor =
    actors.find(({ id }) => id === filters.actorId) ??
    (selectedActorDetails?.id === filters.actorId
      ? selectedActorDetails
      : null) ??
    (filters.actorId === null
      ? null
      : {
          deletedAt: null,
          id: filters.actorId,
          image: null,
          name: null,
        });
  let actorEmptyLabel = t("common.noResults");
  if (actorsQuery.isPending || actorsQuery.isFetching) {
    actorEmptyLabel = t("common.loading");
  }
  if (actorsQuery.error) {
    actorEmptyLabel = t("common.unexpectedError");
  }
  const activeFilterCount = [
    filters.action !== "all",
    filters.actorId !== null,
    filters.from !== null,
    filters.toExclusive !== null,
  ].filter(Boolean).length;

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          debouncedSetActorSearch.cancel();
          setActorSearch("");
        }
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={t("common.filter")}
            className="h-7 gap-1.5 text-xs [@media(any-pointer:coarse)]:h-11"
            size="sm"
            variant="ghost"
          />
        }
      >
        <ListFilterIcon className="size-3.5" />
        {activeFilterCount > 0
          ? t("workspaces.views.filtersWithCount", {
              count: activeFilterCount,
            })
          : t("common.filter")}
      </PopoverTrigger>
      <PopoverPanel align="end" className="w-80">
        <div className="space-y-1.5">
          <label
            className="text-muted-foreground text-xs font-medium"
            htmlFor="matter-activity-action"
          >
            {t("common.actions")}
          </label>
          <Select<MatterActivityAction>
            onValueChange={(action) => {
              if (action) {
                onFiltersChange({ ...filters, action });
              }
            }}
            value={filters.action}
          >
            <SelectTrigger id="matter-activity-action" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {MATTER_ACTIVITY_ACTIONS.map((action) => (
                <SelectItem
                  key={action}
                  label={t(actionLabelKeys[action])}
                  value={action}
                >
                  {t(actionLabelKeys[action])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label
            className="text-muted-foreground text-xs font-medium"
            htmlFor="matter-activity-actor"
          >
            {t("workspaces.overview.activity.list.actor")}
          </label>
          <Combobox<MatterActivityActor>
            filter={null}
            items={actors}
            itemToStringLabel={(actor) =>
              actor.name ?? t("workspaces.overview.activity.list.actor")
            }
            onValueChange={(actor) => {
              setSelectedActorDetails(actor);
              onFiltersChange({ ...filters, actorId: actor?.id ?? null });
            }}
            onInputValueChange={(value) =>
              debouncedSetActorSearch(value.trim())
            }
            value={selectedActor}
          >
            <ComboboxInput
              id="matter-activity-actor"
              placeholder={t("common.all")}
              showClear
              size="sm"
            />
            <ComboboxPopup>
              <ComboboxList>
                {actors.map((actor) => (
                  <ComboboxItem key={actor.id} value={actor}>
                    <BidiText>
                      {actor.name ??
                        t("workspaces.overview.activity.list.actor")}
                    </BidiText>
                  </ComboboxItem>
                ))}
              </ComboboxList>
              <ComboboxEmpty>{actorEmptyLabel}</ComboboxEmpty>
              {actorsQuery.hasNextPage && (
                <Button
                  className="m-1 min-h-11"
                  disabled={actorsQuery.isFetchingNextPage}
                  onClick={() => {
                    const request = actorsQuery
                      .fetchNextPage()
                      .then((result) => {
                        if (result.isError) {
                          getAnalytics().captureError(result.error);
                          stellaToast.add({
                            description: userErrorFromThrown(
                              result.error,
                              t("common.unexpectedError"),
                            ),
                            title: t("errors.actionFailed"),
                            type: "error",
                          });
                        }
                        return result;
                      })
                      .catch((error: unknown) => {
                        getAnalytics().captureError(error);
                        stellaToast.add({
                          description: userErrorFromThrown(
                            error,
                            t("common.unexpectedError"),
                          ),
                          title: t("errors.actionFailed"),
                          type: "error",
                        });
                      });
                    detached(request, "activity-panel.fetch-actors");
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {actorsQuery.isFetchingNextPage
                    ? t("common.loading")
                    : t("common.loadMore")}
                </Button>
              )}
            </ComboboxPopup>
          </Combobox>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <span
              className="text-muted-foreground block text-xs font-medium"
              id="matter-activity-from-label"
            >
              {t("workspaces.filters.from")}
            </span>
            <DatePickerPopover
              id="matter-activity-from"
              labelledBy="matter-activity-from-label"
              {...(toDate === null ? {} : { maxDate: toDate })}
              onChange={onFromDateChange}
              value={fromDate}
            />
          </div>
          <div className="space-y-1.5">
            <span
              className="text-muted-foreground block text-xs font-medium"
              id="matter-activity-to-label"
            >
              {t("workspaces.filters.to")}
            </span>
            <DatePickerPopover
              id="matter-activity-to"
              labelledBy="matter-activity-to-label"
              {...(fromDate === null ? {} : { minDate: fromDate })}
              onChange={onToDateChange}
              value={toDate}
            />
          </div>
        </div>
        <Button
          className="w-full"
          disabled={activeFilterCount === 0 && filters.category === "all"}
          onClick={() => {
            onFromDateChange(null);
            onToDateChange(null);
            onFiltersChange(DEFAULT_MATTER_ACTIVITY_FILTERS);
          }}
          size="sm"
          variant="ghost"
        >
          {t("workspaces.filters.clearAll")}
        </Button>
      </PopoverPanel>
    </Popover>
  );
};

const ActivityExportMenu = ({
  filters,
  workspaceId,
}: {
  filters: MatterActivityFilters;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [exporting, setExporting] = useState(false);

  const exportActivity = async (format: "csv" | "json") => {
    setExporting(true);
    const result = await Result.tryPromise({
      try: async () =>
        await exportOverviewActivity({
          filters,
          format,
          signal: AbortSignal.timeout(30_000),
          workspaceId,
        }),
      catch: (error) => error,
    });
    setExporting(false);
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({
        title:
          APIError.is(result.error) && result.error.status === 413
            ? t("settings.organization.auditLogsExportTooLarge")
            : t("workspaces.views.exportFailed"),
        type: "error",
      });
      return;
    }

    const data = result.value;
    const blob =
      data instanceof Response
        ? await data.blob()
        : new Blob(
            [
              format === "json" && typeof data !== "string"
                ? JSON.stringify(data)
                : String(data),
            ],
            {
              type:
                format === "csv"
                  ? "text/csv; charset=utf-8"
                  : "application/json; charset=utf-8",
            },
          );
    downloadFile(blob, `matter-activity.${format}`);
  };

  const startExport = (format: "csv" | "json") => {
    detached(
      exportActivity(format).catch((error: unknown) => {
        getAnalytics().captureError(error);
        stellaToast.add({
          title: t("workspaces.views.exportFailed"),
          type: "error",
        });
      }),
      "activity-panel.export",
    );
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.download")}
        disabled={exporting}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <DownloadIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => startExport("csv")}>
          {t("workspaces.views.exportCsv")}
        </MenuItem>
        <MenuItem onClick={() => startExport("json")}>
          {t("clauses.exportAsJson")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};

const ActivityTimeline = ({
  filters,
  onSelectedGroupChange,
  selectedGroupId,
  viewMode,
  workspaceId,
}: {
  filters: MatterActivityFilters;
  onSelectedGroupChange: (groupId: string | null) => void;
  selectedGroupId: string | null;
  viewMode: ActivityViewMode;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const query = useSuspenseInfiniteQuery(
    overviewActivityOptions({ activeOrganizationId, filters, workspaceId }),
  );
  const items = query.data.pages.flatMap((page) => page.items);
  const groups = groupActivityItems(items);
  const days = groupActivityDays(groups);
  const selectedGroup = resolveSelectedActivityGroup(groups, selectedGroupId);
  const onSelectGroup = (group: ActivityGroup) => {
    onSelectedGroupChange(group.id);
  };
  const loadEarlier = () => {
    const request = query
      .fetchNextPage()
      .then((result) => {
        if (result.isError) {
          // The resolved error result reaches the user through the same toast
          // as a rejection, so it is captured here too; the `.catch` below only
          // sees a rejected request.
          getAnalytics().captureError(result.error);
          stellaToast.add({
            description: userErrorFromThrown(
              result.error,
              t("common.unexpectedError"),
            ),
            title: t("errors.actionFailed"),
            type: "error",
          });
        }
        return result;
      })
      .catch((error: unknown) => {
        getAnalytics().captureError(error);
        stellaToast.add({
          description: userErrorFromThrown(error, t("common.unexpectedError")),
          title: t("errors.actionFailed"),
          type: "error",
        });
      });
    detached(request, "activity-panel.fetch-next-page");
  };

  let activityContent: ReactNode;
  if (days.length === 0) {
    activityContent = (
      <p className="text-muted-foreground px-4 py-8 text-center text-sm">
        {t("workspaces.overview.activity.empty")}
      </p>
    );
  } else if (viewMode === "list") {
    activityContent = (
      <>
        <ActivityList groups={groups} onSelectGroup={onSelectGroup} />
        {query.hasNextPage && (
          <ActivityLoadSentinel
            hasError={query.isFetchNextPageError}
            isFetching={query.isFetchingNextPage}
            onLoadEarlier={loadEarlier}
          />
        )}
      </>
    );
  } else {
    activityContent = (
      <>
        <HorizontalTimeline
          days={days}
          hasNextPage={query.hasNextPage}
          hasNextPageError={query.isFetchNextPageError}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadEarlier={loadEarlier}
          onSelectGroup={onSelectGroup}
        />
        <div className="md:hidden">
          {days.map((dayGroups) => (
            <div key={activityDayKey(dayGroups[0].items[0].activityAt)}>
              <TimelineDateMarker
                activityAt={dayGroups[0].items[0].activityAt}
              />
              {dayGroups.map((group) => (
                <ActivityRunRow
                  group={group}
                  key={group.id}
                  onSelectGroup={onSelectGroup}
                />
              ))}
            </div>
          ))}
          {query.hasNextPage && (
            <ActivityLoadSentinel
              hasError={query.isFetchNextPageError}
              isFetching={query.isFetchingNextPage}
              onLoadEarlier={loadEarlier}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg-background ring-foreground/5 overflow-hidden rounded-xl shadow-sm ring-1">
        {activityContent}
      </div>
      <ActivityDetailsSheet
        group={selectedGroup}
        onOpenChange={(open) => {
          if (!open) {
            onSelectedGroupChange(null);
          }
        }}
        workspaceId={workspaceId}
      />
    </>
  );
};

type ActivityLoadSentinelProps = {
  hasError: boolean;
  horizontal?: boolean;
  isFetching: boolean;
  onLoadEarlier: () => void;
};

type ObserveActivityIntersectionOptions = {
  node: HTMLSpanElement;
  onIntersect: () => void;
  root: Element | null;
};

const observeActivityIntersection = ({
  node,
  onIntersect,
  root,
}: ObserveActivityIntersectionOptions) => {
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.at(0)?.isIntersecting) {
        return;
      }
      observer.disconnect();
      onIntersect();
    },
    { root },
  );
  observer.observe(node);
  return () => observer.disconnect();
};

const ActivityLoadSentinel = ({
  hasError,
  horizontal = false,
  isFetching,
  onLoadEarlier,
}: ActivityLoadSentinelProps) => {
  const t = useTranslations();
  const loadEarlier = useLatestCallback(onLoadEarlier);
  const sentinelRef = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node || hasError || isFetching) {
        return undefined;
      }
      const root = horizontal ? node.closest("[data-activity-scroll]") : null;
      if (horizontal && !root) {
        return undefined;
      }
      return observeActivityIntersection({
        node,
        onIntersect: loadEarlier,
        root,
      });
    },
    [hasError, horizontal, isFetching, loadEarlier],
  );

  if (hasError) {
    return (
      <Button
        className={cn(
          horizontal ? "mx-4 min-h-11 shrink-0 self-end" : "m-2 min-h-11",
        )}
        disabled={isFetching}
        onClick={loadEarlier}
        size="sm"
        variant="ghost"
      >
        {isFetching
          ? t("workspaces.overview.activity.loading")
          : t("common.tryAgain")}
      </Button>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(horizontal ? "h-px w-px shrink-0" : "block h-px w-px")}
      ref={sentinelRef}
    />
  );
};

const ACTIVITY_SKELETON_WIDTHS = ["w-24", "w-32", "w-28", "w-36"] as const;

const revealCurrentActivity = (node: HTMLSpanElement | null) => {
  if (!node) {
    return;
  }
  const scrollArea = node.closest<HTMLElement>("[data-activity-scroll]");
  if (!scrollArea) {
    return;
  }
  const prefersReducedMotion = globalThis.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const behavior =
    scrollArea.dataset["activityPositioned"] && !prefersReducedMotion
      ? "smooth"
      : "instant";
  scrollArea.dataset["activityPositioned"] = "true";
  node.scrollIntoView({ behavior, block: "nearest", inline: "end" });
};

const ActivityTimelineSkeleton = () => (
  <div
    aria-hidden="true"
    className="bg-background ring-foreground/5 overflow-hidden rounded-xl shadow-sm ring-1"
  >
    <div className="hidden overflow-hidden md:block">
      <div className="flex min-w-max px-5 pt-4 pb-5">
        {ACTIVITY_SKELETON_WIDTHS.map((width, index) => (
          <div className="w-64 shrink-0" key={width}>
            {index === 0 ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <div className="h-3" />
            )}
            <Skeleton className="mt-2 h-2 w-12" />
            <div className="relative mt-3 h-3">
              <span className="bg-border absolute start-0 end-0 top-1/2 h-px" />
              <span className="bg-foreground-disabled absolute start-0 top-0 h-3 w-px" />
            </div>
            <div className="mt-3 pe-8">
              <Skeleton className={cn("h-3", width)} />
              <Skeleton className="mt-3 h-3 w-40" />
            </div>
          </div>
        ))}
      </div>
    </div>
    <div className="py-2 md:hidden">
      {ACTIVITY_SKELETON_WIDTHS.slice(0, 3).map((width) => (
        <div
          className="grid min-h-16 grid-cols-[5.5rem_1.5rem_minmax(0,1fr)]"
          key={width}
        >
          <Skeleton className="ms-auto me-1 mt-3 h-2 w-12" />
          <span className="relative flex justify-center">
            <span className="bg-border absolute inset-y-0 start-1/2 w-px" />
          </span>
          <div className="py-3 ps-3 pe-4">
            <Skeleton className={cn("h-3", width)} />
            <Skeleton className="mt-3 h-3 w-40" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

const HorizontalTimeline = ({
  days,
  hasNextPageError,
  hasNextPage,
  isFetchingNextPage,
  onLoadEarlier,
  onSelectGroup,
}: {
  days: ActivityDay[];
  hasNextPageError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadEarlier: () => void;
  onSelectGroup: (group: ActivityGroup) => void;
}) => (
  <div
    className="hidden overflow-x-auto overscroll-x-contain md:block"
    data-activity-scroll=""
  >
    <div className="flex min-w-max snap-x snap-proximity flex-row-reverse px-5 pt-4 pb-5">
      <HorizontalTodayMarker />
      <span
        aria-hidden="true"
        className="size-px shrink-0"
        key={days.at(0)?.at(0)?.id}
        ref={revealCurrentActivity}
      />
      {days.flatMap((dayGroups) =>
        dayGroups.map((group, index) => (
          <HorizontalActivityMilestone
            dateAt={
              index === dayGroups.length - 1
                ? group.items[0].activityAt
                : undefined
            }
            group={group}
            key={group.id}
            onSelectGroup={onSelectGroup}
          />
        )),
      )}
      {hasNextPage && (
        <ActivityLoadSentinel
          hasError={hasNextPageError}
          horizontal
          isFetching={isFetchingNextPage}
          onLoadEarlier={onLoadEarlier}
        />
      )}
    </div>
  </div>
);

const HorizontalTodayMarker = () => {
  const t = useTranslations();
  return (
    <div className="w-20 shrink-0 snap-end">
      <div className="h-5" />
      <div className="text-destructive mt-1 h-4 text-end text-[11px] font-medium">
        {t("common.today")}
      </div>
      <div aria-hidden="true" className="relative mt-2 h-3">
        <span className="bg-border absolute start-0 end-0 top-1/2 h-px" />
        <span className="bg-destructive absolute end-0 top-0 h-3 w-px" />
      </div>
    </div>
  );
};

const HorizontalActivityMilestone = ({
  dateAt,
  group,
  onSelectGroup,
}: {
  dateAt: string | undefined;
  group: ActivityGroup;
  onSelectGroup: (group: ActivityGroup) => void;
}) => {
  const t = useTranslations();
  const { items } = group;
  const first = items[0];

  if (group.type !== "automation_run") {
    return (
      <HorizontalMilestoneFrame activityAt={first.activityAt} dateAt={dateAt}>
        <button
          className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-start rounded-md px-2 py-1 text-start transition-colors"
          onClick={() => onSelectGroup(group)}
          type="button"
        >
          <ActivityTriplet detail="provenance" group={group} size="compact" />
        </button>
      </HorizontalMilestoneFrame>
    );
  }

  const marker =
    first.performer.type === "agent" ? (
      <BotIcon className="size-4" />
    ) : (
      <WorkflowIcon className="size-4" />
    );
  const showProvenance =
    resolveVisibleActivityTriggerType(first.trigger.type) !== null;
  return (
    <HorizontalMilestoneFrame activityAt={first.activityAt} dateAt={dateAt}>
      <div className="flex min-h-5 items-center gap-1.5 text-[13px] leading-5 font-medium">
        <span className="text-muted-foreground">{marker}</span>
        <BidiText as="span">
          {first.performer.name ??
            t("workspaces.overview.activity.automatedService")}
        </BidiText>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground text-xs font-normal">
          <RunCount count={items.length} />
        </span>
      </div>
      {showProvenance && (
        <p className="text-muted-foreground mt-0.5 text-[11px] leading-4">
          <TriggerDetail item={first} />
        </p>
      )}
      <div className="mt-3 space-y-1">
        {items.map((item) => (
          <HorizontalRunActivityItem
            item={item}
            key={item.id}
            onSelectGroup={onSelectGroup}
          />
        ))}
      </div>
    </HorizontalMilestoneFrame>
  );
};

const HorizontalMilestoneFrame = ({
  activityAt,
  children,
  dateAt,
}: {
  activityAt: string;
  children: ReactNode;
  dateAt: string | undefined;
}) => {
  const format = useFormatter();
  const date = new Date(activityAt);
  return (
    <article className="animate-in fade-in-0 slide-in-from-right-1 rtl:slide-in-from-left-1 w-64 shrink-0 snap-start duration-300 motion-reduce:animate-none">
      <div className="text-muted-foreground h-5 pe-8 text-[13px] font-medium tabular-nums">
        {dateAt
          ? format.dateTime(new Date(dateAt), { dateStyle: "long" })
          : null}
      </div>
      <Tooltip
        content={format.dateTime(date, FULL_DATE_LONG_TIME_FORMAT)}
        render={
          <time
            className="text-muted-foreground mt-1 block h-4 pe-8 text-[11px] tabular-nums"
            dateTime={activityAt}
          >
            {format.dateTime(date, { timeStyle: "short" })}
          </time>
        }
      />
      <div aria-hidden="true" className="relative mt-2 h-3">
        <span className="bg-border absolute start-0 end-0 top-1/2 h-px" />
        <span className="bg-muted-foreground absolute start-0 top-0 h-3 w-px" />
      </div>
      <div className="mt-3 min-w-0 pe-8">{children}</div>
    </article>
  );
};

const HorizontalRunActivityItem = ({
  item,
  onSelectGroup,
}: {
  item: MatterActivityItem;
  onSelectGroup: (group: ActivityGroup) => void;
}) => (
  <button
    className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-center rounded-md px-2 text-start transition-colors"
    onClick={() => onSelectGroup(toSingleActivityGroup(item))}
    type="button"
  >
    <ActivityTriplet group={toSingleActivityGroup(item)} size="compact" />
  </button>
);

const ActivityRunRow = ({
  group,
  onSelectGroup,
}: {
  group: ActivityGroup;
  onSelectGroup: (group: ActivityGroup) => void;
}) => {
  const t = useTranslations();
  const { items } = group;
  const first = items[0];
  if (group.type !== "automation_run") {
    return <ActivityItemRow group={group} onSelectGroup={onSelectGroup} />;
  }

  const showProvenance =
    resolveVisibleActivityTriggerType(first.trigger.type) !== null;
  const marker =
    first.performer.type === "agent" ? (
      <BotIcon className="size-3.5" />
    ) : (
      <WorkflowIcon className="size-3.5" />
    );

  return (
    <TimelineEntry activityAt={first.activityAt} marker={marker}>
      <div className="min-w-0 py-2.5 ps-3 pe-4">
        <div className="flex min-h-6 items-center gap-1.5 text-sm font-medium">
          <BidiText as="span">
            {first.performer.name ??
              t("workspaces.overview.activity.automatedService")}
          </BidiText>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground text-xs font-normal">
            <RunCount count={items.length} />
          </span>
        </div>
        {showProvenance && (
          <p className="text-muted-foreground mt-0.5 text-xs">
            <TriggerDetail item={first} />
          </p>
        )}
        <div className="mt-2.5 space-y-0.5 ps-3">
          {items.map((item) => (
            <RunActivityItem
              item={item}
              key={item.id}
              onSelectGroup={onSelectGroup}
            />
          ))}
        </div>
      </div>
    </TimelineEntry>
  );
};

const TimelineDateMarker = ({ activityAt }: { activityAt: string }) => {
  const format = useFormatter();
  return (
    <div className="grid min-h-11 grid-cols-[5.5rem_1.5rem_minmax(0,1fr)]">
      <span aria-hidden="true" />
      <span className="relative flex items-center justify-center">
        <span
          aria-hidden="true"
          className="bg-border absolute inset-y-0 start-1/2 w-px"
        />
        <span
          aria-hidden="true"
          className="bg-muted-foreground relative z-10 h-px w-3"
        />
      </span>
      <time
        className="text-muted-foreground flex items-center ps-3 pe-4 text-xs font-medium tabular-nums"
        dateTime={activityAt}
      >
        {format.dateTime(new Date(activityAt), { dateStyle: "long" })}
      </time>
    </div>
  );
};

const TimelineEntry = ({
  activityAt,
  children,
  marker,
}: {
  activityAt: string;
  children: ReactNode;
  marker: ReactElement;
}) => {
  const format = useFormatter();
  const date = new Date(activityAt);
  return (
    <div className="group grid grid-cols-[5.5rem_1.5rem_minmax(0,1fr)]">
      <Tooltip
        content={format.dateTime(date, FULL_DATE_LONG_TIME_FORMAT)}
        render={
          <time
            className="text-muted-foreground flex items-start justify-end pe-1 pt-3 text-[11px] tabular-nums"
            dateTime={activityAt}
          >
            {format.dateTime(date, { timeStyle: "short" })}
          </time>
        }
      />
      <span className="relative flex justify-center">
        <span
          aria-hidden="true"
          className="bg-border absolute inset-y-0 start-1/2 w-px"
        />
        <span className="bg-background text-muted-foreground ring-background group-hover:text-foreground relative z-10 mt-2.5 flex size-7 items-center justify-center rounded-full ring-4 transition-colors">
          {marker}
        </span>
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
};

const RunActivityItem = ({
  item,
  onSelectGroup,
}: {
  item: MatterActivityItem;
  onSelectGroup: (group: ActivityGroup) => void;
}) => (
  <button
    className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-center rounded-md px-2 text-start transition-colors"
    onClick={() => onSelectGroup(toSingleActivityGroup(item))}
    type="button"
  >
    <ActivityTriplet group={toSingleActivityGroup(item)} size="default" />
  </button>
);

const RunCount = ({ count }: { count: number }) => {
  const t = useTranslations();
  return <span>{t("workspaces.overview.activity.runCount", { count })}</span>;
};

const ActivityItemRow = ({
  group,
  onSelectGroup,
}: {
  group: ActivityGroup;
  onSelectGroup: (group: ActivityGroup) => void;
}) => {
  const item = group.items[0];
  const icon = activityGroupTargetIcon(group);

  return (
    <TimelineEntry activityAt={item.activityAt} marker={icon}>
      <button
        className="hover:bg-muted/40 flex min-h-11 w-full items-center rounded-md py-2 ps-3 pe-4 text-start transition-colors"
        onClick={() => onSelectGroup(group)}
        type="button"
      >
        <ActivityTriplet detail="provenance" group={group} size="default" />
      </button>
    </TimelineEntry>
  );
};

const ActivityList = ({
  groups,
  onSelectGroup,
}: {
  groups: ActivityGroup[];
  onSelectGroup: (group: ActivityGroup) => void;
}) => {
  const format = useFormatter();
  const t = useTranslations();
  const listGroups = expandActivityGroupsForList(groups);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-start">
        <caption className="sr-only">
          {t("workspaces.overview.activity.title")}
        </caption>
        <thead className="sr-only md:not-sr-only">
          <tr className="text-muted-foreground border-b text-[11px] font-medium">
            <th className="w-40 px-4 py-2 text-start font-medium" scope="col">
              {t("workspaces.overview.activity.list.dateTime")}
            </th>
            <th className="w-48 px-4 py-2 text-start font-medium" scope="col">
              {t("workspaces.overview.activity.list.actor")}
            </th>
            <th className="px-4 py-2 text-start font-medium" scope="col">
              {t("common.itemTypeValues.event")}
            </th>
            <th className="w-56 px-4 py-2 text-start font-medium" scope="col">
              {t("workspaces.overview.activity.list.provenance")}
            </th>
          </tr>
        </thead>
        <tbody className="block md:table-row-group">
          {listGroups.map((group) => {
            const item = group.items[0];
            const showProvenance =
              resolveVisibleActivityTriggerType(item.trigger.type) !== null;
            return (
              <tr
                className="group grid grid-cols-2 border-b last:border-b-0 md:table-row"
                key={group.id}
              >
                <td className="px-4 pt-3 align-middle md:table-cell md:py-2.5">
                  <time
                    className="text-muted-foreground text-xs tabular-nums"
                    dateTime={item.activityAt}
                  >
                    {format.dateTime(
                      new Date(item.activityAt),
                      MEDIUM_DATE_SHORT_TIME_FORMAT,
                    )}
                  </time>
                </td>
                <td className="min-w-0 px-4 pt-3 text-end align-middle text-sm md:table-cell md:py-2.5 md:text-start">
                  <Performer item={item} />
                </td>
                <td className="col-span-2 min-w-0 p-0 align-middle text-sm leading-5 md:table-cell">
                  <button
                    className="hover:bg-muted/40 focus-visible:bg-muted/40 min-h-14 w-full px-4 py-2.5 text-start transition-colors"
                    onClick={() => onSelectGroup(group)}
                    type="button"
                  >
                    <span className="block">
                      <ActivityAction group={group} />
                    </span>
                    <span className="mt-1 grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-1.5 font-medium">
                      <span className="flex size-5 items-center justify-center">
                        {activityGroupTargetIcon(group)}
                      </span>
                      <BidiText as="span">
                        <ActivityGroupTargetName group={group} />
                      </BidiText>
                    </span>
                  </button>
                </td>
                <td className="text-muted-foreground col-span-2 min-w-0 px-4 pb-3 align-middle text-xs leading-4 md:table-cell md:py-2.5">
                  {showProvenance ? <TriggerDetail item={item} /> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const ActivityDetailsSheet = ({
  group,
  onOpenChange,
  workspaceId,
}: {
  group: ActivityGroup | null;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) => {
  const format = useFormatter();
  const t = useTranslations();
  if (!group) {
    return null;
  }

  const item = group.items[0];
  const showProvenance =
    resolveVisibleActivityTriggerType(item.trigger.type) !== null;
  // Every decision in a folded review sitting is about the same document, so
  // the group opens it the way a single row does.
  const openTarget =
    group.items.length === 1 || group.type === "review_decisions"
      ? getOpenTarget(item, workspaceId)
      : undefined;
  const rows = [
    {
      label: t("workspaces.overview.activity.details.dateTime"),
      value: (
        <time dateTime={item.activityAt}>
          {format.dateTime(
            new Date(item.activityAt),
            FULL_DATE_LONG_TIME_FORMAT,
          )}
        </time>
      ),
    },
    ...(group.type === "document_batch" && group.items.length > 1
      ? [
          {
            label: t("workspaces.overview.activity.filters.documents"),
            value: (
              <div className="space-y-1">
                {group.items.map((batchItem) => {
                  const batchOpenTarget = getOpenTarget(batchItem, workspaceId);
                  const content = (
                    <>
                      <span className="flex size-5 shrink-0 items-center justify-center">
                        {activityTargetIcon(batchItem)}
                      </span>
                      <span className="min-w-0">
                        <BidiText as="span" className="block wrap-break-word">
                          <TargetName item={batchItem} />
                        </BidiText>
                        <span className="text-muted-foreground mt-0.5 block text-xs leading-4 tabular-nums">
                          <time dateTime={batchItem.activityAt}>
                            {format.dateTime(
                              new Date(batchItem.activityAt),
                              MEDIUM_DATE_SHORT_TIME_FORMAT,
                            )}
                          </time>
                          <span aria-hidden="true"> · </span>
                          {t("workspaces.overview.activity.details.eventId")}:{" "}
                          <BidiText as="span" className="break-all">
                            {batchItem.id}
                          </BidiText>
                        </span>
                      </span>
                    </>
                  );
                  if (!batchOpenTarget) {
                    return (
                      <div
                        className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5 py-1"
                        key={batchItem.id}
                      >
                        {content}
                      </div>
                    );
                  }
                  return (
                    <button
                      className="hover:bg-muted -ms-2 grid min-h-11 w-[calc(100%+0.5rem)] grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-1.5 rounded-md px-2 py-1 text-start transition-colors"
                      key={batchItem.id}
                      onClick={() => {
                        onOpenChange(false);
                        batchOpenTarget();
                      }}
                      type="button"
                    >
                      {content}
                    </button>
                  );
                })}
              </div>
            ),
          },
        ]
      : []),
    ...(showProvenance
      ? [
          {
            label: t("workspaces.overview.activity.details.trigger"),
            value: <TriggerDetail item={item} />,
          },
        ]
      : []),
    ...(item.approval.status !== "not_required"
      ? [
          {
            label: t("workspaces.overview.activity.details.approval"),
            value: <ApprovalName status={item.approval.status} />,
          },
        ]
      : []),
    ...(item.approval.user
      ? [
          {
            label: t("workspaces.overview.activity.details.approvedBy"),
            value: <BidiText as="span">{item.approval.user.name}</BidiText>,
          },
        ]
      : []),
    ...(item.runId
      ? [
          {
            label: t("workspaces.overview.activity.details.runId"),
            value: <BidiText as="span">{item.runId}</BidiText>,
          },
        ]
      : []),
    {
      label: t("workspaces.overview.activity.details.eventId"),
      value: <BidiText as="span">{item.id}</BidiText>,
    },
  ];

  return (
    <Sheet onOpenChange={onOpenChange} open>
      <SheetPopup side="inline-end" variant="inset">
        <SheetHeader>
          <SheetTitle>
            {t("workspaces.overview.activity.details.title")}
          </SheetTitle>
          <SheetDescription className="text-foreground pe-8">
            <ActivityTriplet group={group} size="default" />
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <dl className="divide-y">
            {rows.map((row) => (
              <div className="grid gap-1 py-3" key={row.label}>
                <dt className="text-muted-foreground text-xs font-medium">
                  {row.label}
                </dt>
                <dd className="min-w-0 text-sm wrap-break-word">{row.value}</dd>
              </div>
            ))}
          </dl>
        </SheetPanel>
        <SheetFooter>
          <SheetClose render={<Button variant="ghost" />}>
            {t("common.close")}
          </SheetClose>
          {openTarget && (
            <SheetClose
              onClick={openTarget}
              render={<Button variant="default" />}
            >
              {t("workspaces.overview.activity.details.openTarget")}
            </SheetClose>
          )}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
};

const SourceName = ({
  source,
}: {
  source: MatterActivityItem["trigger"]["source"];
}) => {
  const t = useTranslations();
  if (!source) {
    return t("workspaces.overview.activity.details.notAvailable");
  }
  switch (source) {
    case "chat":
      return t("workspaces.overview.activity.sources.chat");
    case "flow":
      return t("common.workflow");
    case "mcp":
      return t("workspaces.overview.activity.sources.mcp");
    default:
      return <BidiText as="span">{source}</BidiText>;
  }
};

const ApprovalName = ({
  status,
}: {
  status: MatterActivityItem["approval"]["status"];
}) => {
  const t = useTranslations();
  switch (status) {
    case "not_required":
      return t("workspaces.overview.activity.approvals.notRequired");
    case "pending":
      return t("workspaces.overview.activity.approvals.pending");
    case "approved":
      return t("workspaces.overview.activity.approvals.approved");
    case "rejected":
      return t("workspaces.overview.activity.approvals.rejected");
    default: {
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
    }
  }
};

const Performer = ({ item }: { item: MatterActivityItem }) => {
  const t = useTranslations();
  if (item.performer.type === "user") {
    return (
      <BidiText as="span" className="inline-flex">
        <PersonMentionLabel
          avatarClassName="size-5 text-[8px]"
          className="inline-flex"
          mention={{
            deletedAt: item.performer.deletedAt,
            image: item.performer.image,
            name:
              item.performer.name ??
              t("workspaces.overview.activity.deletedUser"),
          }}
        />
      </BidiText>
    );
  }
  return (
    <BidiText
      as="span"
      className="inline-flex items-center gap-1.5 font-medium"
    >
      <span className="flex size-5 items-center justify-center">
        {item.performer.type === "agent" ? (
          <BotIcon className="size-3.5" />
        ) : (
          <WorkflowIcon className="size-3.5" />
        )}
      </span>
      {item.performer.name ??
        t("workspaces.overview.activity.automatedService")}
    </BidiText>
  );
};

type ActivityTripletProps = {
  detail?: "provenance";
  group: ActivityGroup;
  size: "compact" | "default";
};

const ActivityTriplet = ({ detail, group, size }: ActivityTripletProps) => {
  const item = group.items[0];
  const compact = size === "compact";
  const showProvenance =
    detail === "provenance" &&
    resolveVisibleActivityTriggerType(item.trigger.type) !== null;
  return (
    <span
      className={cn(
        "min-w-0 wrap-anywhere",
        compact ? "text-[13px] leading-5" : "text-sm leading-5",
      )}
    >
      <span className="block min-h-5 font-medium">
        <Performer item={item} />
      </span>
      <span className="mt-1 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5">
        <span aria-hidden="true" />
        <span>
          <ActivityAction group={group} />
        </span>
      </span>
      <span className="mt-1 grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-1.5 font-medium">
        <span className="flex size-5 items-center justify-center">
          {activityGroupTargetIcon(group)}
        </span>
        <BidiText as="span">
          <ActivityGroupTargetName group={group} />
        </BidiText>
      </span>
      {showProvenance && (
        <span
          className={cn(
            compact
              ? "text-muted-foreground mt-0.5 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5 text-[11px] leading-4"
              : "text-muted-foreground mt-0.5 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5 text-xs leading-4",
          )}
        >
          <span aria-hidden="true" />
          <span>
            <TriggerDetail item={item} />
          </span>
        </span>
      )}
    </span>
  );
};

/**
 * The row's sentence about what happened. A document review states itself: the
 * run row names the document it started on, and a sitting of decisions states
 * how many findings it settled, so neither reads as a bare verb over an
 * unnamed automation.
 */
const ActivityAction = ({ group }: { group: ActivityGroup }) => {
  const t = useTranslations();
  const item = group.items[0];
  if (group.type === "review_decisions") {
    return t("workspaces.overview.activity.documentReview.decided", {
      count: group.items.length,
    });
  }
  if (item.target.kind === "documentReviewRun" && item.action === "execute") {
    return t("workspaces.overview.activity.documentReview.started");
  }
  return t(ROW_ACTION_LABEL_KEYS[item.action]);
};

const TargetName = ({ item }: { item: MatterActivityItem }) => {
  const t = useTranslations();
  return item.target.name || t(TARGET_LABEL_KEYS[item.target.kind]);
};

const TriggerLabelWithSource = ({
  children,
  source,
}: {
  children: ReactNode;
  source: MatterActivityItem["trigger"]["source"];
}): ReactNode => {
  if (!source) {
    return children;
  }
  return (
    <>
      {children} · <SourceName source={source} />
    </>
  );
};

const TriggerDetail = ({ item }: { item: MatterActivityItem }) => {
  const t = useTranslations();
  const rawUser = item.trigger.user?.name;
  const user = rawUser ? isolateBidi(rawUser) : null;
  const triggerType = resolveVisibleActivityTriggerType(item.trigger.type);
  if (!triggerType) {
    return null;
  }
  switch (triggerType) {
    case "user_dispatch": {
      if (!user) {
        return t("workspaces.overview.activity.provenance.dispatched");
      }
      if (item.trigger.source === "chat") {
        return t("workspaces.overview.activity.provenance.dispatchedInChatBy", {
          user,
        });
      }
      return t("workspaces.overview.activity.provenance.dispatchedBy", {
        user,
      });
    }
    case "schedule":
      return user
        ? t("workspaces.overview.activity.provenance.scheduledBy", { user })
        : t("workspaces.overview.activity.provenance.scheduled");
    case "credential":
      return user
        ? t("workspaces.overview.activity.provenance.connectedBy", { user })
        : t("workspaces.overview.activity.provenance.connected");
    case "agent_delegation":
      return user
        ? t("workspaces.overview.activity.provenance.delegatedBy", { user })
        : t("workspaces.overview.activity.provenance.delegated");
    case "webhook":
      return (
        <TriggerLabelWithSource source={item.trigger.source}>
          {t("workspaces.overview.activity.details.webhook")}
        </TriggerLabelWithSource>
      );
    case "system":
      return (
        <TriggerLabelWithSource source={item.trigger.source}>
          {t("workspaces.overview.activity.details.system")}
        </TriggerLabelWithSource>
      );
    default: {
      triggerType satisfies never;
      return panic(`Unhandled trigger type: ${String(triggerType)}`);
    }
  }
};

const targetIcon = (item: MatterActivityItem) => {
  const { kind } = item.target;
  switch (kind) {
    case "document":
    case "folder":
    case "task":
    case "message":
    case "link":
      return (
        <EntityKindIcon
          className="text-muted-foreground size-3.5"
          fileName={item.target.name}
          kind={kind}
          mimeType={item.target.mimeType}
        />
      );
    // A review row is about its document, so it wears the document's icon.
    case "documentReviewRun":
      return (
        <DocumentIcon
          className="size-3.5"
          fileName={item.target.name}
          mimeType={item.target.mimeType}
        />
      );
    case "translationRun":
      return <LanguagesIcon className="text-muted-foreground size-3.5" />;
    case "playbook":
      return <ListChecksIcon className="text-muted-foreground size-3.5" />;
    case "matter":
      return (
        <MatterIcon
          className="size-3.5"
          matter={{ color: item.target.color, id: item.target.id }}
        />
      );
    case "team":
      return <UsersIcon className="text-muted-foreground size-3.5" />;
    case "court":
      return <ScaleIcon className="text-muted-foreground size-3.5" />;
    case "automation":
      return <WorkflowIcon className="text-muted-foreground size-3.5" />;
    default: {
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};

const activityTargetIcon = (item: MatterActivityItem) => {
  if (
    item.target.kind === "document" &&
    (item.target.mimeType || item.target.name)
  ) {
    return (
      <DocumentIcon
        className="size-3.5"
        fileName={item.target.name}
        mimeType={item.target.mimeType}
      />
    );
  }
  return targetIcon(item);
};

const activityGroupTargetIcon = (group: ActivityGroup) => {
  if (group.type === "document_batch" && group.items.length > 1) {
    return (
      <span
        aria-hidden="true"
        className="flex w-5 items-center [&>*+*]:-ms-2.5"
      >
        {group.items.slice(0, 3).map((item) => (
          <span
            className="bg-background flex size-3.5 shrink-0 items-center justify-center rounded-[2px]"
            key={item.id}
          >
            {activityTargetIcon(item)}
          </span>
        ))}
      </span>
    );
  }
  return activityTargetIcon(group.items[0]);
};

const ActivityGroupTargetName = ({ group }: { group: ActivityGroup }) => {
  const t = useTranslations();
  if (group.type === "document_batch" && group.items.length > 1) {
    return t("workspaces.documentsCount", { count: group.items.length });
  }
  return <TargetName item={group.items[0]} />;
};

const getOpenTarget = (item: MatterActivityItem, workspaceId: string) => {
  const { target } = item;
  if (target.deleted || !target.entityId) {
    return undefined;
  }
  if (target.kind === "task") {
    return () =>
      useInspectorTabsStore.getState().openTask({
        label: target.name ?? "",
        taskId: target.entityId ?? target.id,
        workspaceId,
      });
  }
  if (
    (target.kind !== "document" && target.kind !== "documentReviewRun") ||
    !target.fieldId ||
    !target.name ||
    !target.mimeType ||
    target.encrypted === null ||
    !isFileDisplayable({
      encrypted: target.encrypted,
      fileName: target.name,
      mimeType: target.mimeType,
      pdfFileId: target.pdfFileId,
    })
  ) {
    return undefined;
  }
  return () =>
    useInspectorTabsStore.getState().openFile({
      entityId: target.entityId ?? target.id,
      fileName: target.name ?? "",
      id: target.fieldId ?? "",
      label: target.name ?? "",
      mimeType: target.mimeType ?? undefined,
      pdfFileId: target.pdfFileId,
      propertyId: target.propertyId ?? undefined,
      workspaceId,
    });
};

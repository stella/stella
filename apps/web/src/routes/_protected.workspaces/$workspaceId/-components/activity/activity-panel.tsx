import { Suspense, useCallback, useDeferredValue, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  BotIcon,
  ChevronDownIcon,
  Clock3Icon,
  FileTextIcon,
  ListIcon,
  ListFilterIcon,
  ScaleIcon,
  SquareCheckIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { SegmentedIconToggle } from "@stll/ui/components/segmented-icon-toggle";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/components/sheet";
import { stellaToast } from "@stll/ui/components/toast";

import { DocumentIcon } from "@/components/document-icon";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterIcon } from "@/components/matter-icon";
import { PersonMentionLabel } from "@/components/person-mention-label";
import Tooltip from "@/components/tooltip";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  FULL_DATE_LONG_TIME_FORMAT,
  MEDIUM_DATE_SHORT_TIME_FORMAT,
} from "@/lib/relative-time";
import { isFileDisplayable } from "@/lib/types";
import {
  MATTER_ACTIVITY_CATEGORIES,
  overviewActivityOptions,
  type MatterActivityCategory,
  type MatterActivityItem,
} from "@/lib/workspaces/queries";

import type { ActivityGroup } from "./activity-panel.logic";
import {
  activityDayKey,
  expandActivityGroupsForList,
  groupActivityItems,
  resolveVisibleActivityTriggerType,
  resolveSelectedActivityGroup,
  toSingleActivityGroup,
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

export const ActivityPanel = ({ workspaceId }: ActivityPanelProps) => {
  const t = useTranslations();
  const [category, setCategory] = useState<MatterActivityCategory>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ActivityViewMode>("timeline");
  const deferredCategory = useDeferredValue(category);
  const isFilterPending = category !== deferredCategory;
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
      <div className="mb-3 flex items-center justify-between">
        <h2
          className="text-muted-foreground text-sm font-medium"
          id="matter-activity-heading"
        >
          {t("workspaces.overview.activity.title")}
        </h2>
        <div className="flex items-center gap-1.5">
          <SegmentedIconToggle
            onChange={setViewMode}
            options={viewOptions}
            size="touch"
            value={viewMode}
          />
          <Menu>
            <MenuTrigger
              aria-label={t("workspaces.overview.activity.filterLabel")}
              className="h-7 gap-1.5 text-xs [@media(any-pointer:coarse)]:h-11"
              render={<Button size="sm" variant="ghost" />}
            >
              <ListFilterIcon className="size-3.5" />
              {t(categoryLabelKeys[category])}
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuRadioGroup value={category}>
                {MATTER_ACTIVITY_CATEGORIES.map((value) => (
                  <MenuRadioItem
                    key={value}
                    onClick={() => {
                      setSelectedGroupId(null);
                      setCategory(value);
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
        className={
          isFilterPending
            ? "opacity-60 transition-opacity duration-150"
            : "opacity-100 transition-opacity duration-150"
        }
      >
        <Suspense fallback={<ActivityTimelineSkeleton />}>
          <ActivityTimeline
            category={deferredCategory}
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

const ActivityTimeline = ({
  category,
  onSelectedGroupChange,
  selectedGroupId,
  viewMode,
  workspaceId,
}: {
  category: MatterActivityCategory;
  onSelectedGroupChange: (groupId: string | null) => void;
  selectedGroupId: string | null;
  viewMode: ActivityViewMode;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const query = useSuspenseInfiniteQuery(
    overviewActivityOptions({ activeOrganizationId, category, workspaceId }),
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
        throw error;
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
        className={
          horizontal ? "mx-4 min-h-11 shrink-0 self-end" : "m-2 min-h-11"
        }
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
      className={horizontal ? "h-px w-px shrink-0" : "block h-px w-px"}
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
            <div
              className={
                index === 0
                  ? "bg-muted h-3 w-24 animate-pulse rounded-sm"
                  : "h-3"
              }
            />
            <div className="bg-muted mt-2 h-2 w-12 animate-pulse rounded-sm" />
            <div className="relative mt-3 h-3">
              <span className="bg-border absolute start-0 end-0 top-1/2 h-px" />
              <span className="bg-foreground-disabled absolute start-0 top-0 h-3 w-px" />
            </div>
            <div className="mt-3 pe-8">
              <div
                className={`bg-muted h-3 animate-pulse rounded-sm ${width}`}
              />
              <div className="bg-muted mt-3 h-3 w-40 animate-pulse rounded-sm" />
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
          <span className="bg-muted ms-auto me-1 mt-3 h-2 w-12 animate-pulse rounded-sm" />
          <span className="relative flex justify-center">
            <span className="bg-border absolute inset-y-0 start-1/2 w-px" />
          </span>
          <span className="py-3 ps-3 pe-4">
            <span
              className={`bg-muted block h-3 animate-pulse rounded-sm ${width}`}
            />
            <span className="bg-muted mt-3 block h-3 w-40 animate-pulse rounded-sm" />
          </span>
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
    <div className="overflow-x-auto" role="list">
      <div className="w-full md:min-w-[57rem]">
        <div
          aria-hidden="true"
          className="text-muted-foreground hidden border-b px-4 py-2 text-[11px] font-medium md:grid md:grid-cols-[10rem_12rem_minmax(16rem,1fr)_14rem] md:gap-4"
        >
          <span>{t("workspaces.overview.activity.list.dateTime")}</span>
          <span>{t("workspaces.overview.activity.list.actor")}</span>
          <span>{t("common.itemTypeValues.event")}</span>
          <span>{t("workspaces.overview.activity.list.provenance")}</span>
        </div>
        {listGroups.map((group) => {
          const item = group.items[0];
          const showProvenance =
            resolveVisibleActivityTriggerType(item.trigger.type) !== null;
          return (
            <div
              className="border-b last:border-b-0"
              key={group.id}
              role="listitem"
            >
              <button
                className="hover:bg-muted/40 focus-visible:bg-muted/40 grid min-h-14 w-full gap-1 px-4 py-2.5 text-start transition-colors md:grid-cols-[10rem_12rem_minmax(16rem,1fr)_14rem] md:items-center md:gap-4"
                onClick={() => onSelectGroup(group)}
                type="button"
              >
                <time
                  className="text-muted-foreground text-xs tabular-nums"
                  dateTime={item.activityAt}
                >
                  {format.dateTime(
                    new Date(item.activityAt),
                    MEDIUM_DATE_SHORT_TIME_FORMAT,
                  )}
                </time>
                <span className="min-w-0 text-sm">
                  <Performer item={item} />
                </span>
                <span className="min-w-0 text-sm leading-5">
                  <span className="block">
                    <ActivityAction item={item} />
                  </span>
                  <span className="mt-1 grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-1.5 font-medium">
                    <span className="flex size-5 items-center justify-center">
                      {activityGroupTargetIcon(group)}
                    </span>
                    <BidiText as="span">
                      <ActivityGroupTargetName group={group} />
                    </BidiText>
                  </span>
                </span>
                <span className="text-muted-foreground min-w-0 text-xs leading-4">
                  {showProvenance ? <TriggerDetail item={item} /> : null}
                </span>
              </button>
            </div>
          );
        })}
      </div>
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
  const openTarget =
    group.items.length === 1 ? getOpenTarget(item, workspaceId) : undefined;
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
                        <BidiText as="span" className="block break-words">
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
                <dd className="min-w-0 text-sm break-words">{row.value}</dd>
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
      return t("workspaces.overview.activity.sources.flow");
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
      const exhaustive: never = status;
      return exhaustive;
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
      className={
        compact ? "min-w-0 text-[13px] leading-5" : "min-w-0 text-sm leading-5"
      }
    >
      <span className="block min-h-5 font-medium">
        <Performer item={item} />
      </span>
      <span className="mt-1 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5">
        <span aria-hidden="true" />
        <span>
          <ActivityAction item={item} />
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
          className={
            compact
              ? "text-muted-foreground mt-0.5 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5 text-[11px] leading-4"
              : "text-muted-foreground mt-0.5 grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-1.5 text-xs leading-4"
          }
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

const ActivityAction = ({ item }: { item: MatterActivityItem }) => {
  const t = useTranslations();
  switch (item.action) {
    case "add":
      return t("workspaces.overview.activity.actorActions.added");
    case "create":
      return t("workspaces.overview.activity.actorActions.created");
    case "update":
      return t("workspaces.overview.activity.actorActions.updated");
    case "delete":
      return t("workspaces.overview.activity.actorActions.deleted");
    case "remove":
      return t("workspaces.overview.activity.actorActions.removed");
    case "execute":
      return t("workspaces.overview.activity.actorActions.executed");
    case "review":
      return t("workspaces.overview.activity.actorActions.reviewed");
    case "cancel":
      return t("workspaces.overview.activity.actorActions.cancelled");
    default:
      return item.action satisfies never;
  }
};

const TargetName = ({ item }: { item: MatterActivityItem }) => {
  const t = useTranslations();
  if (item.target.name) {
    return item.target.name;
  }
  switch (item.target.kind) {
    case "document":
      return t("workspaces.overview.activity.targets.document");
    case "task":
      return t("workspaces.overview.activity.targets.task");
    case "matter":
      return t("workspaces.overview.activity.targets.matter");
    case "team":
      return t("workspaces.overview.activity.targets.team");
    case "court":
      return t("workspaces.overview.activity.targets.court");
    case "automation":
      return t("workspaces.overview.activity.targets.automation");
    default: {
      const exhaustive: never = item.target.kind;
      return exhaustive;
    }
  }
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
      const exhaustive: never = triggerType;
      return exhaustive;
    }
  }
};

const targetIcon = (item: MatterActivityItem) => {
  switch (item.target.kind) {
    case "document":
      return <FileTextIcon className="text-muted-foreground size-3.5" />;
    case "task":
      return <SquareCheckIcon className="text-muted-foreground size-3.5" />;
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
      const exhaustive: never = item.target.kind;
      return exhaustive;
    }
  }
};

const activityTargetIcon = (item: MatterActivityItem) => {
  if (item.target.kind === "document" && item.target.mimeType) {
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
    target.kind !== "document" ||
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

import { Suspense, useDeferredValue, useMemo, useState } from "react";
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

import { PersonMentionLabel } from "@/components/person-mention-label";
import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import type { getTranslator } from "@/i18n/i18n-store";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { isFileDisplayable } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  MatterActivityCategory,
  MatterActivityItem,
} from "@/routes/_protected.workspaces/-queries";
import { overviewActivityOptions } from "@/routes/_protected.workspaces/-queries";

import {
  activityActionVerb,
  activityDayKey,
  groupActivityRuns,
} from "./activity-panel.logic";

type ActivityPanelProps = { workspaceId: string };
type ActivityDay = [MatterActivityItem, ...MatterActivityItem[]];
type ActivityViewMode = "timeline" | "list";
type ActivityTranslator = ReturnType<typeof getTranslator>;

const FIRST_STRONG_ISOLATE = String.fromCodePoint(8296);
const POP_DIRECTIONAL_ISOLATE = String.fromCodePoint(8297);
const isolateBidi = (value: string): string =>
  `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`;

const CATEGORIES: MatterActivityCategory[] = [
  "all",
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
];

const categoryLabel = (
  category: MatterActivityCategory,
  t: ActivityTranslator,
) => {
  switch (category) {
    case "all":
      return t("workspaces.overview.activity.filters.all");
    case "documents":
      return t("workspaces.overview.activity.filters.documents");
    case "tasks":
      return t("workspaces.overview.activity.filters.tasks");
    case "matter":
      return t("workspaces.overview.activity.filters.matter");
    case "team":
      return t("workspaces.overview.activity.filters.team");
    case "court":
      return t("workspaces.overview.activity.filters.court");
    case "automation":
      return t("workspaces.overview.activity.filters.automation");
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
};

export const ActivityPanel = ({ workspaceId }: ActivityPanelProps) => {
  const t = useTranslations();
  const [category, setCategory] = useState<MatterActivityCategory>("all");
  const [selectedItem, setSelectedItem] = useState<MatterActivityItem | null>(
    null,
  );
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
              {categoryLabel(category, t)}
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuRadioGroup value={category}>
                {CATEGORIES.map((value) => (
                  <MenuRadioItem
                    key={value}
                    onClick={() => {
                      setSelectedItem(null);
                      setCategory(value);
                    }}
                    value={value}
                  >
                    {categoryLabel(value, t)}
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
            onSelectItem={setSelectedItem}
            viewMode={viewMode}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>
      <ActivityDetailsSheet
        item={selectedItem}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedItem(null);
          }
        }}
        workspaceId={workspaceId}
      />
    </section>
  );
};

const ActivityTimeline = ({
  category,
  onSelectItem,
  viewMode,
  workspaceId,
}: {
  category: MatterActivityCategory;
  onSelectItem: (item: MatterActivityItem) => void;
  viewMode: ActivityViewMode;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const query = useSuspenseInfiniteQuery(
    overviewActivityOptions({ activeOrganizationId, category, workspaceId }),
  );
  const items = query.data.pages.flatMap((page) => page.items);
  const days = useMemo(() => {
    const result = new Map<string, ActivityDay>();
    for (const item of items) {
      const key = activityDayKey(item.activityAt);
      const dayItems = result.get(key);
      if (dayItems) {
        dayItems.push(item);
      } else {
        result.set(key, [item]);
      }
    }
    return [...result.values()];
  }, [items]);

  let activityContent: ReactNode;
  if (days.length === 0) {
    activityContent = (
      <p className="text-muted-foreground px-4 py-8 text-center text-sm">
        {t("workspaces.overview.activity.empty")}
      </p>
    );
  } else if (viewMode === "list") {
    activityContent = (
      <ActivityList items={items} onSelectItem={onSelectItem} />
    );
  } else {
    activityContent = (
      <>
        <HorizontalTimeline days={days} onSelectItem={onSelectItem} />
        <div className="md:hidden">
          {days.map((dayItems) => (
            <div key={activityDayKey(dayItems[0].activityAt)}>
              <TimelineDateMarker activityAt={dayItems[0].activityAt} />
              {groupActivityRuns(dayItems).map((run) => (
                <ActivityRunRow
                  items={run.items}
                  key={run.id}
                  onSelectItem={onSelectItem}
                />
              ))}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg-background ring-foreground/5 overflow-hidden rounded-xl shadow-sm ring-1">
        {activityContent}
      </div>

      {query.hasNextPage && (
        <div className="mt-2 flex justify-center">
          <Button
            disabled={query.isFetchingNextPage}
            onClick={() => {
              const request = query
                .fetchNextPage()
                .then((result) => {
                  if (result.isError) {
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
                  stellaToast.add({
                    description: userErrorFromThrown(
                      error,
                      t("common.unexpectedError"),
                    ),
                    title: t("errors.actionFailed"),
                    type: "error",
                  });
                  throw error;
                });
              detached(request, "ActivityPanel.fetchNextPage");
            }}
            size="sm"
            variant="ghost"
          >
            {query.isFetchingNextPage
              ? t("workspaces.overview.activity.loading")
              : t("workspaces.overview.activity.loadEarlier")}
          </Button>
        </div>
      )}
    </>
  );
};

const ACTIVITY_SKELETON_WIDTHS = ["w-24", "w-32", "w-28", "w-36"] as const;

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
  onSelectItem,
}: {
  days: ActivityDay[];
  onSelectItem: (item: MatterActivityItem) => void;
}) => (
  <div className="hidden overflow-x-auto overscroll-x-contain md:block">
    <div className="flex min-w-max snap-x snap-proximity px-5 pt-4 pb-5">
      {days.flatMap((dayItems) =>
        groupActivityRuns(dayItems).map((run, index) => (
          <HorizontalActivityMilestone
            dateAt={index === 0 ? dayItems[0].activityAt : undefined}
            items={run.items}
            key={run.id}
            onSelectItem={onSelectItem}
          />
        )),
      )}
    </div>
  </div>
);

const HorizontalActivityMilestone = ({
  dateAt,
  items,
  onSelectItem,
}: {
  dateAt: string | undefined;
  items: MatterActivityItem[];
  onSelectItem: (item: MatterActivityItem) => void;
}) => {
  const t = useTranslations();
  const first = items[0];
  if (!first) {
    return null;
  }

  if (first.runId === null) {
    const detail = triggerDetail(first, t);
    const target = (
      <BidiText as="span" className="font-medium">
        {targetName(first, t)}
      </BidiText>
    );
    const content = (
      <span className="min-w-0">
        <span className="flex min-h-5 items-center text-[13px] leading-5 font-medium">
          <Performer item={first} />
        </span>
        {detail && (
          <span className="text-muted-foreground mt-0.5 block text-[11px] leading-4">
            {detail}
          </span>
        )}
        <span className="mt-2 block text-[13px] leading-5">
          {actionSentence(first, <Performer item={first} />, target, t)}
        </span>
      </span>
    );

    return (
      <HorizontalMilestoneFrame activityAt={first.activityAt} dateAt={dateAt}>
        <button
          className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-start rounded-md px-2 py-1 text-start transition-colors"
          onClick={() => onSelectItem(first)}
          type="button"
        >
          {content}
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
  const detail = triggerDetail(first, t);
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
      {detail && (
        <p className="text-muted-foreground mt-0.5 text-[11px] leading-4">
          {detail}
        </p>
      )}
      <div className="mt-3 space-y-1">
        {items.map((item) => (
          <HorizontalRunActivityItem
            item={item}
            key={item.id}
            onSelectItem={onSelectItem}
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
    <article className="w-64 shrink-0 snap-start">
      <div className="text-muted-foreground h-5 pe-8 text-[13px] font-medium tabular-nums">
        {dateAt
          ? format.dateTime(new Date(dateAt), { dateStyle: "long" })
          : null}
      </div>
      <Tooltip
        content={format.dateTime(date, {
          dateStyle: "full",
          timeStyle: "medium",
        })}
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
  onSelectItem,
}: {
  item: MatterActivityItem;
  onSelectItem: (item: MatterActivityItem) => void;
}) => {
  const t = useTranslations();
  const target = (
    <BidiText as="span" className="font-medium">
      {targetName(item, t)}
    </BidiText>
  );
  const sentence = actionSentence(item, <Performer item={item} />, target, t);
  return (
    <button
      className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-center rounded-md px-2 text-start transition-colors"
      onClick={() => onSelectItem(item)}
      type="button"
    >
      <span className="text-[13px] leading-5">{sentence}</span>
    </button>
  );
};

const ActivityRunRow = ({
  items,
  onSelectItem,
}: {
  items: MatterActivityItem[];
  onSelectItem: (item: MatterActivityItem) => void;
}) => {
  const t = useTranslations();
  const first = items[0];
  if (!first) {
    return null;
  }
  if (first.runId === null) {
    return <ActivityItemRow item={first} onSelectItem={onSelectItem} />;
  }

  const detail = triggerDetail(first, t);
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
        {detail && (
          <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>
        )}
        <div className="mt-2.5 space-y-0.5 ps-3">
          {items.map((item) => (
            <RunActivityItem
              item={item}
              key={item.id}
              onSelectItem={onSelectItem}
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
        content={format.dateTime(date, {
          dateStyle: "full",
          timeStyle: "medium",
        })}
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
  onSelectItem,
}: {
  item: MatterActivityItem;
  onSelectItem: (item: MatterActivityItem) => void;
}) => {
  const t = useTranslations();
  const target = (
    <BidiText as="span" className="font-medium">
      {targetName(item, t)}
    </BidiText>
  );
  const sentence = actionSentence(item, <Performer item={item} />, target, t);
  return (
    <button
      className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-center rounded-md px-2 text-start transition-colors"
      onClick={() => onSelectItem(item)}
      type="button"
    >
      <span className="text-sm leading-5">{sentence}</span>
    </button>
  );
};

const RunCount = ({ count }: { count: number }) => {
  const t = useTranslations();
  return <span>{t("workspaces.overview.activity.runCount", { count })}</span>;
};

const ActivityItemRow = ({
  item,
  onSelectItem,
}: {
  item: MatterActivityItem;
  onSelectItem: (item: MatterActivityItem) => void;
}) => {
  const t = useTranslations();
  const actor = <Performer item={item} />;
  const target = (
    <BidiText as="span" className="font-medium">
      {targetName(item, t)}
    </BidiText>
  );
  const sentence = actionSentence(item, actor, target, t);
  const detail = triggerDetail(item, t);
  const icon = targetIcon(item.target.kind);

  const content = (
    <span className="min-w-0 text-sm">
      <span className="block leading-5">{sentence}</span>
      {detail && (
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {detail}
        </span>
      )}
    </span>
  );

  return (
    <TimelineEntry activityAt={item.activityAt} marker={icon}>
      <button
        className="hover:bg-muted/40 flex min-h-11 w-full items-center rounded-md py-2 ps-3 pe-4 text-start transition-colors"
        onClick={() => onSelectItem(item)}
        type="button"
      >
        {content}
      </button>
    </TimelineEntry>
  );
};

const ActivityList = ({
  items,
  onSelectItem,
}: {
  items: MatterActivityItem[];
  onSelectItem: (item: MatterActivityItem) => void;
}) => {
  const format = useFormatter();
  const t = useTranslations();
  return (
    <div className="overflow-x-auto" role="list">
      <div className="min-w-full md:w-max md:min-w-[57rem]">
        <div
          aria-hidden="true"
          className="text-muted-foreground hidden border-b px-4 py-2 text-[11px] font-medium md:grid md:grid-cols-[10rem_12rem_minmax(16rem,1fr)_14rem] md:gap-4"
        >
          <span>{t("workspaces.overview.activity.list.dateTime")}</span>
          <span>{t("workspaces.overview.activity.list.actor")}</span>
          <span>{t("workspaces.overview.activity.list.event")}</span>
          <span>{t("workspaces.overview.activity.list.provenance")}</span>
        </div>
        {items.map((item) => {
          const target = (
            <BidiText as="span" className="font-medium">
              {targetName(item, t)}
            </BidiText>
          );
          const provenance = triggerDetail(item, t);
          return (
            <div
              className="border-b last:border-b-0"
              key={item.id}
              role="listitem"
            >
              <button
                className="hover:bg-muted/40 focus-visible:bg-muted/40 grid min-h-14 w-full gap-1 px-4 py-2.5 text-start transition-colors md:grid-cols-[10rem_12rem_minmax(16rem,1fr)_14rem] md:items-center md:gap-4"
                onClick={() => onSelectItem(item)}
                type="button"
              >
                <time
                  className="text-muted-foreground text-xs tabular-nums"
                  dateTime={item.activityAt}
                >
                  {format.dateTime(new Date(item.activityAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
                <span className="min-w-0 text-sm">
                  <Performer item={item} />
                </span>
                <span className="min-w-0 text-sm leading-5">
                  {actionSentence(item, <Performer item={item} />, target, t)}
                </span>
                <span className="text-muted-foreground min-w-0 text-xs leading-4">
                  {provenance ??
                    (item.trigger.source
                      ? sourceName(item.trigger.source, t)
                      : "—")}
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
  item,
  onOpenChange,
  workspaceId,
}: {
  item: MatterActivityItem | null;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) => {
  const format = useFormatter();
  const t = useTranslations();
  if (!item) {
    return null;
  }

  const target = (
    <BidiText as="span" className="font-medium">
      {targetName(item, t)}
    </BidiText>
  );
  const openTarget = getOpenTarget(item, workspaceId);
  const rows = [
    {
      label: t("workspaces.overview.activity.details.dateTime"),
      value: (
        <time dateTime={item.activityAt}>
          {format.dateTime(new Date(item.activityAt), {
            dateStyle: "full",
            timeStyle: "long",
          })}
        </time>
      ),
    },
    {
      label: t("workspaces.overview.activity.details.actor"),
      value: <Performer item={item} />,
    },
    {
      label: t("workspaces.overview.activity.details.target"),
      value: target,
    },
    {
      label: t("common.category"),
      value: categoryLabel(item.category, t),
    },
    {
      label: t("workspaces.overview.activity.details.trigger"),
      value: triggerName(item, t),
    },
    {
      label: t("workspaces.overview.activity.details.channel"),
      value: sourceName(item.trigger.source, t),
    },
    {
      label: t("workspaces.overview.activity.details.approval"),
      value: approvalName(item.approval.status, t),
    },
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
          <SheetDescription className="pe-8">
            {actionSentence(item, <Performer item={item} />, target, t)}
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

const sourceName = (
  source: MatterActivityItem["trigger"]["source"],
  t: ActivityTranslator,
) => {
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

const triggerName = (item: MatterActivityItem, t: ActivityTranslator) => {
  const detail = triggerDetail(item, t);
  if (detail) {
    return detail;
  }
  switch (item.trigger.type) {
    case "direct":
      return t("workspaces.overview.activity.details.direct");
    case "webhook":
      return t("workspaces.overview.activity.details.webhook");
    case "system":
      return t("workspaces.overview.activity.details.system");
    default:
      return t("workspaces.overview.activity.details.notAvailable");
  }
};

const approvalName = (
  status: MatterActivityItem["approval"]["status"],
  t: ActivityTranslator,
) => {
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
    <BidiText as="span" className="inline-flex items-center gap-1 font-medium">
      {item.performer.type === "agent" ? (
        <BotIcon className="size-3.5" />
      ) : (
        <WorkflowIcon className="size-3.5" />
      )}
      {item.performer.name ??
        t("workspaces.overview.activity.automatedService")}
    </BidiText>
  );
};

const actionSentence = (
  item: MatterActivityItem,
  actor: ReactElement | null,
  target: ReactElement,
  t: ActivityTranslator,
): ReactElement => {
  const values = { actor: () => actor, target: () => target };
  const action = activityActionVerb(item.action, item.target.kind);
  switch (action) {
    case "create":
      return (
        <>{t.rich("workspaces.overview.activity.actions.created", values)}</>
      );
    case "update":
      return (
        <>{t.rich("workspaces.overview.activity.actions.updated", values)}</>
      );
    case "delete":
      return (
        <>{t.rich("workspaces.overview.activity.actions.deleted", values)}</>
      );
    case "remove":
      return (
        <>{t.rich("workspaces.overview.activity.actions.removed", values)}</>
      );
    case "execute":
      return (
        <>{t.rich("workspaces.overview.activity.actions.executed", values)}</>
      );
    case "review":
      return (
        <>{t.rich("workspaces.overview.activity.actions.reviewed", values)}</>
      );
    case "cancel":
      return (
        <>{t.rich("workspaces.overview.activity.actions.cancelled", values)}</>
      );
    default:
      return target;
  }
};

const targetName = (item: MatterActivityItem, t: ActivityTranslator) => {
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

const triggerDetail = (item: MatterActivityItem, t: ActivityTranslator) => {
  const rawUser = item.trigger.user?.name;
  const user = rawUser ? isolateBidi(rawUser) : null;
  switch (item.trigger.type) {
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
    default:
      return null;
  }
};

const targetIcon = (kind: MatterActivityItem["target"]["kind"]) => {
  switch (kind) {
    case "document":
      return <FileTextIcon className="text-muted-foreground size-3.5" />;
    case "task":
      return <SquareCheckIcon className="text-muted-foreground size-3.5" />;
    case "matter":
      return <ScaleIcon className="text-muted-foreground size-3.5" />;
    case "team":
      return <UsersIcon className="text-muted-foreground size-3.5" />;
    case "court":
      return <ScaleIcon className="text-muted-foreground size-3.5" />;
    case "automation":
      return <WorkflowIcon className="text-muted-foreground size-3.5" />;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const getOpenTarget = (item: MatterActivityItem, workspaceId: string) => {
  const { target } = item;
  if (target.deleted || !target.entityId) {
    return undefined;
  }
  if (target.kind === "task") {
    return () =>
      useInspectorStore.getState().openTask({
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
    useInspectorStore.getState().openFile({
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

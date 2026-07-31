import { useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  BotIcon,
  ChevronDownIcon,
  FileTextIcon,
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

import { PersonMentionLabel } from "@/components/person-mention-label";
import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  MatterActivityCategory,
  MatterActivityItem,
} from "@/routes/_protected.workspaces/-queries";
import { overviewActivityOptions } from "@/routes/_protected.workspaces/-queries";

import { activityDayKey, groupActivityRuns } from "./activity-panel.logic";

type ActivityPanelProps = { workspaceId: string };

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
  t: ReturnType<typeof useTranslations>,
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
  const format = useFormatter();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const [category, setCategory] = useState<MatterActivityCategory>("all");
  const query = useSuspenseInfiniteQuery(
    overviewActivityOptions({ activeOrganizationId, category, workspaceId }),
  );
  const items = query.data.pages.flatMap((page) => page.items);
  const days = useMemo(() => {
    const result = new Map<
      string,
      [MatterActivityItem, ...MatterActivityItem[]]
    >();
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

  return (
    <section aria-labelledby="matter-activity-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2
          className="text-muted-foreground text-sm font-medium"
          id="matter-activity-heading"
        >
          {t("workspaces.overview.activity.title")}
        </h2>
        <Menu>
          <MenuTrigger
            aria-label={t("workspaces.overview.activity.filterLabel")}
            className="h-7 gap-1.5 text-xs"
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
                  onClick={() => setCategory(value)}
                  value={value}
                >
                  {categoryLabel(value, t)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      </div>

      <div className="bg-background overflow-hidden rounded-xl shadow-sm ring-1 ring-foreground/5">
        {days.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-center text-sm">
            {t("workspaces.overview.activity.empty")}
          </p>
        ) : (
          days.map((dayItems) => (
            <div key={activityDayKey(dayItems[0].activityAt)}>
              <TimelineDateMarker activityAt={dayItems[0].activityAt} />
              {groupActivityRuns(dayItems).map((run) => (
                <ActivityRunRow
                  items={run.items}
                  key={run.id}
                  workspaceId={workspaceId}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {query.hasNextPage && (
        <div className="mt-2 flex justify-center">
          <Button
            disabled={query.isFetchingNextPage}
            onClick={() => {
              detached(query.fetchNextPage(), "ActivityPanel.fetchNextPage");
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
    </section>
  );
};

const ActivityRunRow = ({
  items,
  workspaceId,
}: {
  items: MatterActivityItem[];
  workspaceId: string;
}) => {
  const t = useTranslations();
  const first = items[0];
  if (!first) {
    return null;
  }
  if (first.runId === null) {
    return <ActivityItemRow item={first} workspaceId={workspaceId} />;
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
      <div className="min-w-0 py-2.5 pe-4 ps-3">
        <div className="flex min-h-6 items-center gap-1.5 text-sm font-medium">
          <span>{first.performer.name}</span>
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
              workspaceId={workspaceId}
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
    <div className="grid min-h-11 grid-cols-[4.75rem_1.5rem_minmax(0,1fr)] sm:grid-cols-[6.5rem_1.5rem_minmax(0,1fr)]">
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
        className="text-muted-foreground flex items-center pe-4 ps-3 text-xs font-medium tabular-nums"
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
    <div className="group grid grid-cols-[4.75rem_1.5rem_minmax(0,1fr)] sm:grid-cols-[6.5rem_1.5rem_minmax(0,1fr)]">
      <Tooltip
        content={format.dateTime(date, {
          dateStyle: "full",
          timeStyle: "medium",
        })}
        render={
          <time
            className="text-muted-foreground flex items-start justify-end pt-3 text-[11px] tabular-nums"
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
  workspaceId,
}: {
  item: MatterActivityItem;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const openTarget = getOpenTarget(item, workspaceId);
  const target = (
    <BidiText as="span" className="font-medium">
      {targetName(item, t)}
    </BidiText>
  );
  const sentence = actionSentence(item.action, null, target, t);
  if (!openTarget) {
    return <div className="py-1.5 text-sm leading-5">{sentence}</div>;
  }
  return (
    <button
      className="hover:bg-muted/40 -ms-2 flex min-h-11 w-[calc(100%+0.5rem)] items-center rounded-md px-2 text-start transition-colors"
      onClick={openTarget}
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
  workspaceId,
}: {
  item: MatterActivityItem;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const openTarget = getOpenTarget(item, workspaceId);
  const actor = <Performer item={item} />;
  const target = (
    <BidiText as="span" className="font-medium">
      {targetName(item, t)}
    </BidiText>
  );
  const sentence = actionSentence(item.action, actor, target, t);
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

  if (!openTarget) {
    return (
      <TimelineEntry activityAt={item.activityAt} marker={icon}>
        <div className="flex min-h-11 items-center py-2 pe-4 ps-3">
          {content}
        </div>
      </TimelineEntry>
    );
  }
  return (
    <TimelineEntry activityAt={item.activityAt} marker={icon}>
      <button
        className="hover:bg-muted/40 flex min-h-11 w-full items-center rounded-md py-2 pe-4 ps-3 text-start transition-colors"
        onClick={openTarget}
        type="button"
      >
        {content}
      </button>
    </TimelineEntry>
  );
};

const Performer = ({ item }: { item: MatterActivityItem }) => {
  const t = useTranslations();
  if (item.performer.type === "user") {
    return (
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
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      {item.performer.type === "agent" ? (
        <BotIcon className="size-3.5" />
      ) : (
        <WorkflowIcon className="size-3.5" />
      )}
      {item.performer.name ??
        t("workspaces.overview.activity.automatedService")}
    </span>
  );
};

const actionSentence = (
  action: MatterActivityItem["action"],
  actor: ReactElement | null,
  target: ReactElement,
  t: ReturnType<typeof useTranslations>,
): ReactElement => {
  const values = { actor: () => actor, target: () => target };
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

const targetName = (
  item: MatterActivityItem,
  t: ReturnType<typeof useTranslations>,
) => {
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

const triggerDetail = (
  item: MatterActivityItem,
  t: ReturnType<typeof useTranslations>,
) => {
  const user = item.trigger.user?.name;
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
  if (target.kind !== "document" || !target.fieldId || !target.name) {
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

import { addDays, parseIsoDateLocal } from "@/lib/dates";
import type {
  MatterActivityFilters,
  MatterActivityItem,
} from "@/lib/workspaces/queries";

const DOCUMENT_BATCH_WINDOW_MS = 60_000;
const FORMULA_PREFIX_RE = /^\s*[=+\-@\t\r\n]/u;

const escapeCsv = (value: string): string => {
  const formula = FORMULA_PREFIX_RE.test(value);
  if (
    !formula &&
    !value.includes(",") &&
    !value.includes('"') &&
    !value.includes("\n") &&
    !value.includes("\r")
  ) {
    return value;
  }
  const escaped = value.replace(/"/gu, '""');
  return formula ? `"\t${escaped}"` : `"${escaped}"`;
};

export const matterActivityCsvRows = (
  items: readonly MatterActivityItem[],
): string[] => {
  const rows = [
    [
      "Time",
      "Actor",
      "Actor type",
      "Action",
      "Category",
      "Target type",
      "Target",
      "Origin",
      "Run ID",
      "Event ID",
    ].join(","),
  ];
  for (const item of items) {
    rows.push(
      [
        item.activityAt,
        item.performer.name ?? "",
        item.performer.type,
        item.action,
        item.category,
        item.target.kind,
        item.target.name ?? "",
        [item.trigger.type, item.trigger.source].filter(Boolean).join(":"),
        item.runId ?? "",
        item.id,
      ]
        .map(escapeCsv)
        .join(","),
    );
  }
  return rows;
};

export const matterActivityJsonExport = ({
  exportedAt,
  filters,
  items,
}: {
  exportedAt: string;
  filters: MatterActivityFilters;
  items: readonly MatterActivityItem[];
}) => ({
  version: 1 as const,
  exportedAt,
  filters,
  items,
});

export const matterActivityExportResponse = ({
  exportedAt,
  filters,
  format,
  items,
}: {
  exportedAt: string;
  filters: MatterActivityFilters;
  format: "csv" | "json";
  items: readonly MatterActivityItem[];
}): Response => {
  const chunks =
    format === "csv"
      ? matterActivityCsvRows(items).map((row) => `${row}\r\n`)
      : [
          JSON.stringify(
            matterActivityJsonExport({ exportedAt, filters, items }),
          ),
        ];
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks.at(index);
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/json; charset=utf-8",
    },
  });
};

export const toMatterActivityDateRange = ({
  from,
  to,
}: {
  from: string | null;
  to: string | null;
}): { from: string | null; toExclusive: string | null } => {
  const fromDate = from === null ? null : parseIsoDateLocal(from);
  const toDate = to === null ? null : parseIsoDateLocal(to);
  return {
    from: fromDate?.toISOString() ?? null,
    toExclusive: toDate ? addDays(toDate, 1).toISOString() : null,
  };
};

type ActivityTriggerType = MatterActivityItem["trigger"]["type"];
type VisibleActivityTriggerType = Exclude<ActivityTriggerType, "direct">;

const VISIBLE_ACTIVITY_TRIGGER_TYPES = {
  agent_delegation: "agent_delegation",
  credential: "credential",
  direct: null,
  schedule: "schedule",
  system: "system",
  user_dispatch: "user_dispatch",
  webhook: "webhook",
} as const satisfies Record<
  ActivityTriggerType,
  VisibleActivityTriggerType | null
>;

export const resolveVisibleActivityTriggerType = (
  type: ActivityTriggerType,
): VisibleActivityTriggerType | null => VISIBLE_ACTIVITY_TRIGGER_TYPES[type];

export const activityDayKey = (activityAt: string): string => {
  const date = new Date(activityAt);
  return Number.isNaN(date.getTime())
    ? activityAt
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export type ActivityGroup =
  | {
      id: string;
      items: [MatterActivityItem, ...MatterActivityItem[]];
      type: "automation_run";
    }
  | {
      id: string;
      items: [MatterActivityItem, ...MatterActivityItem[]];
      type: "document_batch";
    }
  | {
      id: string;
      items: [MatterActivityItem];
      type: "single";
    };

const isBatchableDocumentCreate = (item: MatterActivityItem) =>
  item.runId === null &&
  item.action === "create" &&
  item.target.kind === "document" &&
  item.performer.type === "user";

const hasSamePerformer = (
  left: MatterActivityItem,
  right: MatterActivityItem,
) => {
  if (left.performer.type !== "user" || right.performer.type !== "user") {
    return false;
  }
  return left.performer.id === right.performer.id;
};

const isWithinDocumentBatchWindow = (
  anchor: MatterActivityItem,
  candidate: MatterActivityItem,
) => {
  const anchorTime = new Date(anchor.activityAt).getTime();
  const candidateTime = new Date(candidate.activityAt).getTime();
  return (
    Number.isFinite(anchorTime) &&
    Number.isFinite(candidateTime) &&
    Math.abs(anchorTime - candidateTime) <= DOCUMENT_BATCH_WINDOW_MS
  );
};

const hasSameActivityDay = (
  left: MatterActivityItem,
  right: MatterActivityItem,
) => activityDayKey(left.activityAt) === activityDayKey(right.activityAt);

export const groupActivityItems = (
  items: MatterActivityItem[],
): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  for (const item of items) {
    const previous = groups.at(-1);
    if (
      item.runId &&
      previous?.type === "automation_run" &&
      previous.items[0].runId === item.runId &&
      hasSameActivityDay(previous.items[0], item)
    ) {
      previous.items.push(item);
      continue;
    }
    if (
      isBatchableDocumentCreate(item) &&
      previous?.type === "document_batch" &&
      hasSamePerformer(previous.items[0], item) &&
      hasSameActivityDay(previous.items[0], item) &&
      isWithinDocumentBatchWindow(previous.items[0], item)
    ) {
      previous.items.push(item);
      continue;
    }
    if (item.runId) {
      groups.push({
        id: `run:${item.runId}:${item.id}`,
        items: [item],
        type: "automation_run",
      });
      continue;
    }
    if (isBatchableDocumentCreate(item)) {
      groups.push({
        id: `document-batch:${item.id}`,
        items: [item],
        type: "document_batch",
      });
      continue;
    }
    groups.push({ id: `item:${item.id}`, items: [item], type: "single" });
  }

  return groups;
};

export const expandActivityGroupsForList = (
  groups: ActivityGroup[],
): ActivityGroup[] =>
  groups.flatMap((group) =>
    group.type === "automation_run"
      ? group.items.map((item) => ({
          id: `item:${item.id}`,
          items: [item],
          type: "single" as const,
        }))
      : [group],
  );

export const toSingleActivityGroup = (
  item: MatterActivityItem,
): ActivityGroup => ({
  id: `item:${item.id}`,
  items: [item],
  type: "single",
});

export const resolveSelectedActivityGroup = (
  groups: ActivityGroup[],
  selectedGroupId: string | null,
): ActivityGroup | null => {
  if (!selectedGroupId) {
    return null;
  }
  for (const group of groups) {
    if (group.id === selectedGroupId) {
      return group;
    }
    const selectedItem = group.items.find(
      ({ id }) => `item:${id}` === selectedGroupId,
    );
    if (selectedItem) {
      return toSingleActivityGroup(selectedItem);
    }
  }
  return null;
};

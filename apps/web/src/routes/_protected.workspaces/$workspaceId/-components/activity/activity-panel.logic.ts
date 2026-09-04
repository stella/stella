import { addDays, parseIsoDateLocal } from "@stll/time";

import type { TranslationKey } from "@/i18n/types";
import type { MatterActivityItem } from "@/lib/workspaces/queries";

/**
 * The verb for a feed row's action. Total over the actions the feed carries,
 * so an audit action the API starts narrating cannot reach a row unlabelled.
 */
export const ROW_ACTION_LABEL_KEYS = {
  add: "workspaces.overview.activity.actorActions.added",
  cancel: "workspaces.overview.activity.actorActions.cancelled",
  create: "workspaces.overview.activity.actorActions.created",
  delete: "workspaces.overview.activity.actorActions.deleted",
  execute: "workspaces.overview.activity.actorActions.executed",
  remove: "workspaces.overview.activity.actorActions.removed",
  review: "workspaces.overview.activity.actorActions.reviewed",
  update: "workspaces.overview.activity.actorActions.updated",
} as const satisfies Record<MatterActivityItem["action"], TranslationKey>;

/**
 * What the row calls its target when the target has no name of its own. Total
 * over the target kinds the API projects: a new kind names itself here or the
 * build fails, which is what stops it from arriving as "automation".
 */
export const TARGET_LABEL_KEYS = {
  automation: "workspaces.overview.activity.targets.automation",
  court: "workspaces.overview.activity.targets.court",
  document: "workspaces.overview.activity.targets.document",
  documentReviewRun: "workspaces.overview.activity.targets.documentReview",
  folder: "workspaces.overview.activity.targets.folder",
  link: "workspaces.overview.activity.targets.link",
  matter: "workspaces.overview.activity.targets.matter",
  message: "workspaces.overview.activity.targets.message",
  playbook: "workspaces.overview.activity.targets.playbook",
  task: "workspaces.overview.activity.targets.task",
  team: "workspaces.overview.activity.targets.team",
  translationRun: "workspaces.overview.activity.targets.translation",
} as const satisfies Record<
  MatterActivityItem["target"]["kind"],
  TranslationKey
>;

const ACTIVITY_FOLD_WINDOW_MS = 60_000;

/**
 * How far apart two decisions on the same review may sit and still read as one
 * sitting. Deciding a review's findings writes one audit row per finding, and
 * a reviewer works through them in a single pass; a row each would bury
 * everything else in the matter.
 */
const REVIEW_DECISION_FOLD_WINDOW_MS = 30 * 60_000;

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

const formatLocalDate = (date: Date): string =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("-");

export const toMatterActivityDatePickerValues = ({
  from,
  toExclusive,
}: {
  from: string | null;
  toExclusive: string | null;
}): { from: string | null; to: string | null } => ({
  from: from === null ? null : formatLocalDate(new Date(from)),
  to:
    toExclusive === null
      ? null
      : formatLocalDate(addDays(new Date(toExclusive), -1)),
});

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
      type: "review_decisions";
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

const isWithinActivityFoldWindow = (
  anchor: MatterActivityItem,
  candidate: MatterActivityItem,
) => {
  const anchorTime = new Date(anchor.activityAt).getTime();
  const candidateTime = new Date(candidate.activityAt).getTime();
  return (
    Number.isFinite(anchorTime) &&
    Number.isFinite(candidateTime) &&
    Math.abs(anchorTime - candidateTime) <= ACTIVITY_FOLD_WINDOW_MS
  );
};

const isUserFolderAction = (
  item: MatterActivityItem,
  action: "create" | "update",
) =>
  item.runId === null &&
  item.action === action &&
  item.target.kind === "folder" &&
  item.performer.type === "user";

const isFoldableFolderRename = (
  candidate: ActivityGroup | undefined,
  createItem: MatterActivityItem,
) =>
  candidate?.type === "single" &&
  isUserFolderAction(candidate.items[0], "update") &&
  candidate.items[0].renameOnly &&
  candidate.items[0].target.id === createItem.target.id &&
  hasSamePerformer(candidate.items[0], createItem) &&
  isWithinActivityFoldWindow(candidate.items[0], createItem);

const hasSameActivityDay = (
  left: MatterActivityItem,
  right: MatterActivityItem,
) => activityDayKey(left.activityAt) === activityDayKey(right.activityAt);

/** One decision on one review's finding, whichever surface took it. */
const isReviewDecision = (item: MatterActivityItem) =>
  item.action === "review" && item.target.kind === "documentReviewRun";

const hasSameActor = (left: MatterActivityItem, right: MatterActivityItem) =>
  left.performer.type === "user" || right.performer.type === "user"
    ? hasSamePerformer(left, right)
    : left.performer.type === right.performer.type &&
      left.performer.name === right.performer.name;

const isWithinReviewDecisionWindow = (
  previous: MatterActivityItem,
  candidate: MatterActivityItem,
) => {
  const previousTime = new Date(previous.activityAt).getTime();
  const candidateTime = new Date(candidate.activityAt).getTime();
  return (
    Number.isFinite(previousTime) &&
    Number.isFinite(candidateTime) &&
    Math.abs(previousTime - candidateTime) <= REVIEW_DECISION_FOLD_WINDOW_MS
  );
};

const foldsIntoReviewDecisions = (
  candidate: ActivityGroup | undefined,
  item: MatterActivityItem,
): candidate is Extract<ActivityGroup, { type: "review_decisions" }> =>
  candidate?.type === "review_decisions" &&
  candidate.items[0].target.id === item.target.id &&
  hasSameActor(candidate.items[0], item) &&
  hasSameActivityDay(candidate.items[0], item) &&
  // Chained from the last folded decision, so a long sitting keeps folding
  // while a decision taken hours later starts its own row.
  isWithinReviewDecisionWindow(
    candidate.items.at(-1) ?? candidate.items[0],
    item,
  );

export const groupActivityItems = (
  items: MatterActivityItem[],
): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  for (const item of items) {
    const previous = groups.at(-1);
    // Before the run grouping below: a decision taken through chat carries a
    // run id, and it still belongs to its review rather than to that run.
    if (isReviewDecision(item)) {
      if (foldsIntoReviewDecisions(previous, item)) {
        previous.items.push(item);
        continue;
      }
      groups.push({
        id: `review-decisions:${item.target.id}:${item.id}`,
        items: [item],
        type: "review_decisions",
      });
      continue;
    }
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
      isWithinActivityFoldWindow(previous.items[0], item)
    ) {
      previous.items.push(item);
      continue;
    }
    // Creating a folder in the UI records a create plus an immediate rename
    // (the inline name edit). Items arrive newest-first, so the renames sit
    // just before their create: fold them into the single "created" entry.
    // Only pure renames fold; a move within the window stays visible.
    if (isUserFolderAction(item, "create")) {
      while (isFoldableFolderRename(groups.at(-1), item)) {
        groups.pop();
      }
      groups.push({ id: `item:${item.id}`, items: [item], type: "single" });
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

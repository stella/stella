export const MATTER_ACTIVITY_CATEGORIES = [
  "all",
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
] as const;

export type MatterActivityCategory =
  (typeof MATTER_ACTIVITY_CATEGORIES)[number];

export const MATTER_ACTIVITY_ACTIONS = [
  "all",
  "create",
  "update",
  "delete",
  "execute",
  "cancel",
  "review",
  "add",
  "remove",
] as const;

export type MatterActivityAction = (typeof MATTER_ACTIVITY_ACTIONS)[number];

export type MatterActivityFilters = {
  action: MatterActivityAction;
  actorId: string | null;
  category: MatterActivityCategory;
  from: string | null;
  toExclusive: string | null;
};

export const DEFAULT_MATTER_ACTIVITY_FILTERS = {
  action: "all",
  actorId: null,
  category: "all",
  from: null,
  toExclusive: null,
} as const satisfies MatterActivityFilters;

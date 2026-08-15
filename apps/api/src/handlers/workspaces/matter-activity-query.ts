import { t } from "elysia";

import type {
  MATTER_ACTIVITY_ACTIONS,
  MATTER_ACTIVITY_CATEGORIES,
  MatterActivityAction,
  MatterActivityCategory,
  MatterActivityFilters,
} from "@stll/api-contract/matter-activity";

import { tUserId } from "@/api/lib/custom-schema";

const MATTER_ACTIVITY_ACTION_SCHEMA_VALUES = [
  "all",
  "create",
  "update",
  "delete",
  "execute",
  "cancel",
  "review",
  "add",
  "remove",
] as const satisfies typeof MATTER_ACTIVITY_ACTIONS;

const MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES = [
  "all",
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
] as const satisfies typeof MATTER_ACTIVITY_CATEGORIES;

export const matterActivityFilterQueryProperties = {
  action: t.Optional(
    t.Union([
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[0]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[1]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[2]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[3]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[4]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[5]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[6]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[7]),
      t.Literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[8]),
    ]),
  ),
  actorId: t.Optional(tUserId),
  category: t.Optional(
    t.Union([
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[0]),
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[1]),
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[2]),
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[3]),
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[4]),
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[5]),
      t.Literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[6]),
    ]),
  ),
  from: t.Optional(t.String({ format: "date-time" })),
  toExclusive: t.Optional(t.String({ format: "date-time" })),
};

type MatterActivityFilterQuery = {
  action?: MatterActivityAction;
  actorId?: string;
  category?: MatterActivityCategory;
  from?: string;
  toExclusive?: string;
};

export const toMatterActivityFilters = ({
  action,
  actorId,
  category,
  from,
  toExclusive,
}: MatterActivityFilterQuery): MatterActivityFilters => ({
  action: action ?? "all",
  actorId: actorId ?? null,
  category: category ?? "all",
  from: from ?? null,
  toExclusive: toExclusive ?? null,
});

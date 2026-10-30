import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";
import type {
  MATTER_ACTIVITY_ACTIONS,
  MATTER_ACTIVITY_CATEGORIES,
  MatterActivityAction,
  MatterActivityCategory,
  MatterActivityFilters,
} from "@stll/api-contract/matter-activity";

import { userIdSchema } from "@/api/lib/custom-schema";

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
  "correspondence",
  "automation",
] as const satisfies typeof MATTER_ACTIVITY_CATEGORIES;

export const matterActivityFilterQueryProperties = {
  action: v.exactOptional(
    v.union([
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[0]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[1]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[2]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[3]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[4]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[5]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[6]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[7]),
      v.literal(MATTER_ACTIVITY_ACTION_SCHEMA_VALUES[8]),
    ]),
  ),
  actorId: v.exactOptional(userIdSchema),
  category: v.exactOptional(
    v.union([
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[0]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[1]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[2]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[3]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[4]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[5]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[6]),
      v.literal(MATTER_ACTIVITY_CATEGORY_SCHEMA_VALUES[7]),
    ]),
  ),
  from: v.exactOptional(apiDateTimeSchema),
  toExclusive: v.exactOptional(apiDateTimeSchema),
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

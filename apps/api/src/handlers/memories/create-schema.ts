import * as v from "valibot";

import { AI_MEMORY_KINDS } from "@/api/db/schema";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const createMemoryFields = {
  kind: v.picklist(AI_MEMORY_KINDS),
  content: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  pinned: v.optional(v.boolean()),
  language: v.optional(v.pipe(v.string(), v.maxLength(10))),
} as const;

export const createMemoryBodySchema = v.union([
  v.strictObject({ ...createMemoryFields, scope: v.literal("user") }),
  v.strictObject({
    ...createMemoryFields,
    scope: v.literal("workspace"),
    workspaceId: resourceIdSchema("workspace"),
  }),
]);

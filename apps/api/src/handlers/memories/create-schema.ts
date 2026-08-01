import { t } from "elysia";
import type { Static } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";

const createMemoryFields = {
  kind: t.UnionEnum([
    "preference",
    "instruction",
    "fact",
    "decision",
    "relationship",
  ]),
  content: t.String({ minLength: 1, maxLength: 4000 }),
  pinned: t.Optional(t.Boolean()),
  language: t.Optional(t.String({ maxLength: 10 })),
} as const;

export const createMemoryBodySchema = t.Union([
  t.Object(
    {
      ...createMemoryFields,
      scope: t.Literal("user"),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...createMemoryFields,
      scope: t.Literal("workspace"),
      workspaceId: tSafeId("workspace"),
    },
    { additionalProperties: false },
  ),
]);

export type CreateMemoryBody = Static<typeof createMemoryBodySchema>;

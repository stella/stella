import { t } from "elysia";
import type { Static } from "elysia";

export const dateOfBirthSchema = t.Union([
  t.Object(
    {
      precision: t.Literal("year"),
      year: t.Integer({ minimum: 1000, maximum: 9999 }),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      precision: t.Literal("month"),
      year: t.Integer({ minimum: 1000, maximum: 9999 }),
      month: t.Integer({ minimum: 1, maximum: 12 }),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      precision: t.Literal("day"),
      year: t.Integer({ minimum: 1000, maximum: 9999 }),
      month: t.Integer({ minimum: 1, maximum: 12 }),
      day: t.Integer({ minimum: 1, maximum: 31 }),
    },
    { additionalProperties: false },
  ),
]);

export type DateOfBirth = Static<typeof dateOfBirthSchema>;

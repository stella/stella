import * as v from "valibot";

export const dateOfBirthSchema = v.union([
  v.strictObject({
    precision: v.literal("year"),
    year: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(9999)),
  }),
  v.strictObject({
    precision: v.literal("month"),
    year: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(9999)),
    month: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)),
  }),
  v.strictObject({
    precision: v.literal("day"),
    year: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(9999)),
    month: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)),
    day: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(31)),
  }),
]);

export type DateOfBirth = v.InferOutput<typeof dateOfBirthSchema>;

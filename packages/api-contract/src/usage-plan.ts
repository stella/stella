import * as v from "valibot";

export const usagePlanSchema = v.variant("type", [
  v.strictObject({ type: v.literal("paid") }),
  v.strictObject({ type: v.literal("evaluation") }),
  v.strictObject({ type: v.literal("free") }),
  v.strictObject({ type: v.literal("self_managed_keys") }),
]);

export const usagePlanResponseSchema = v.strictObject({
  plan: usagePlanSchema,
});

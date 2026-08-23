import * as v from "valibot";

export const envCollabServerSchema = {
  STELLA_API_URL: v.pipe(v.string(), v.url()),
  STELLA_COLLAB_PORT: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(65_535),
    ),
    "3002",
  ),
};

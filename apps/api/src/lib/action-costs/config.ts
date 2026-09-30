import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { isRecord } from "@/api/lib/type-guards";

const ratesSchema = v.record(
  v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
);
class ActionCostConfigError extends TaggedError("ActionCostConfigError")<{
  message: string;
  cause?: unknown;
}> {}

export const parseActionCostRates = (value: string | undefined) => {
  if (value === undefined) {
    return Result.ok(v.parse(ratesSchema, {}));
  }
  return Result.try({
    try: () => {
      const decoded: unknown = JSON.parse(value);
      if (!isRecord(decoded)) {
        throw new ActionCostConfigError({
          message: "Action cost rates must be an object",
        });
      }
      return v.parse(ratesSchema, decoded);
    },
    catch: (cause) =>
      new ActionCostConfigError({
        message: "Action cost rates are invalid",
        cause,
      }),
  });
};

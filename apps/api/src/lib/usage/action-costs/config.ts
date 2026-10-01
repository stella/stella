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
  const decoded = Result.try({
    try: () => {
      const parsed: unknown = JSON.parse(value);
      return parsed;
    },
    catch: (cause) =>
      new ActionCostConfigError({
        message: "Action cost rates are invalid",
        cause,
      }),
  });
  if (Result.isError(decoded)) {
    return decoded;
  }
  if (!isRecord(decoded.value)) {
    return Result.err(
      new ActionCostConfigError({
        message: "Action cost rates must be an object",
      }),
    );
  }
  const parsed = v.safeParse(ratesSchema, decoded.value);
  if (!parsed.success) {
    return Result.err(
      new ActionCostConfigError({
        message: "Action cost rates are invalid",
        cause: parsed.issues,
      }),
    );
  }
  return Result.ok(parsed.output);
};

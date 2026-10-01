import * as v from "valibot";

import { isRecord } from "@/api/lib/type-guards";

/** Share the declared map shape across wire and parser contracts. */
export const plainRecord = <TValue extends v.GenericSchema>(value: TValue) => {
  const record = v.record(v.string(), value);
  const guarded = v.pipe(
    v.custom<Record<string, unknown>>(isRecord, "Expected an object"),
    record,
  );
  return {
    ...record,
    "~run": guarded["~run"],
    "~standard": guarded["~standard"],
    "~types": guarded["~types"],
  };
};

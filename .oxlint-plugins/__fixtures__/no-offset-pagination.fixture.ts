// Passive regression fixture for `no-offset-pagination/no-offset-pagination`.

import * as v from "valibot";

declare const numberFromString: (
  schema: v.GenericSchema<number>,
) => v.GenericSchema<string, number>;
declare const pageOffsetSchema: () => v.GenericSchema<number>;
declare const page: number;

// oxlint-disable-next-line no-offset-pagination/no-offset-pagination -- fixture proves a direct request offset schema is rejected
const directOffsetSchema = { offset: v.pipe(v.number(), v.integer()) };
const wrappedOffsetSchema = {
  // oxlint-disable-next-line no-offset-pagination/no-offset-pagination -- fixture proves wrappers and wire helpers cannot hide an offset
  offset: v.exactOptional(numberFromString(v.number())),
};
// oxlint-disable-next-line no-offset-pagination/no-offset-pagination -- fixture proves a schema helper is a request offset too
const helperOffsetSchema = { offset: v.optional(pageOffsetSchema()) };

// expect-clean: no-offset-pagination/no-offset-pagination
const cursorSchema = { cursor: v.optional(v.string()), limit: v.number() };
const runtimeOffset = { offset: 20 };
const computedOffset = { offset: page * 20 };

export {
  computedOffset,
  cursorSchema,
  directOffsetSchema,
  helperOffsetSchema,
  runtimeOffset,
  wrappedOffsetSchema,
};

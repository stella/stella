import * as v from "valibot";

// Pagination cursor without a bound: the rule must report this shape.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _unbounded = { cursor: v.optional(v.string()) };

// A bounded inline string is a second copy of the helper's cap: reported.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _bounded = { cursor: v.optional(v.pipe(v.string(), v.maxLength(512))) };

// A string-literal key names the same property. Written computed because the
// formatter unquotes a plain `"cursor":` key, and the point of the case is
// that the rule reads the key's value rather than its spelling: reported.
const _quoted = {
  // oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema, no-useless-computed-key -- the computed spelling is the only string-literal key the formatter leaves alone
  ["cursor"]: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
};

// Bare, without the optional wrapper: reported.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _required = { cursor: v.pipe(v.string(), v.maxLength(512)) };

// Nested wrappers do not hide the inline string: reported.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _nested = { cursor: v.nullish(v.optional(v.string())) };

// The shared helper owns both the default and provider-specific bounds.
const paginationCursorSchema = ({ maxChars = 512 } = {}) =>
  v.pipe(v.string(), v.maxLength(maxChars));
const isCursor = (cursor: string) => cursor.length > 0;
// expect-clean: require-pagination-cursor-schema/require-pagination-cursor-schema
const _shared = { cursor: v.optional(paginationCursorSchema()) };
const _providerCursor = {
  cursor: v.optional(paginationCursorSchema({ maxChars: 4096 })),
};
const _checkedCursor = {
  cursor: v.optional(v.pipe(paginationCursorSchema(), v.check(isCursor))),
};

// Optional strings that are not pagination cursors are outside the rule.
const _query = { query: v.optional(v.string()) };

export const __requirePaginationCursorSchemaFixture = {
  _unbounded,
  _bounded,
  _quoted,
  _required,
  _nested,
  _shared,
  _providerCursor,
  _checkedCursor,
  _query,
};

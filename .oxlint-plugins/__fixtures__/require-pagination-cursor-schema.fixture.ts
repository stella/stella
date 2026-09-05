import { t } from "elysia";

// Pagination cursor without a bound: the rule must report this shape.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _unbounded = { cursor: t.Optional(t.String()) };

// A bounded inline string is a second copy of the helper's cap: reported.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _bounded = { cursor: t.Optional(t.String({ maxLength: 512 })) };

// A string-literal key names the same property. Written computed because the
// formatter unquotes a plain `"cursor":` key, and the point of the case is
// that the rule reads the key's value rather than its spelling: reported.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema, no-useless-computed-key -- the computed spelling is the only string-literal key the formatter leaves alone
const _quoted = { ["cursor"]: t.Optional(t.String({ maxLength: 512 })) };

// Bare, without the optional wrapper: reported.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _required = { cursor: t.String({ maxLength: 512 }) };

// The shared helper owns both the default and provider-specific bounds.
const tPaginationCursor = (maxLength = 512) => t.String({ maxLength });
const _shared = { cursor: t.Optional(tPaginationCursor()) };
const _providerCursor = { cursor: t.Optional(tPaginationCursor(4096)) };

// Optional strings that are not pagination cursors are outside the rule.
const _query = { query: t.Optional(t.String()) };

export const __requirePaginationCursorSchemaFixture = {
  _unbounded,
  _bounded,
  _quoted,
  _required,
  _shared,
  _providerCursor,
  _query,
};

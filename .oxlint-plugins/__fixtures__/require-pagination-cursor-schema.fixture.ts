import { t } from "elysia";

// Pagination cursor without a bound: the rule must report this shape.
// oxlint-disable-next-line require-pagination-cursor-schema/require-pagination-cursor-schema
const _unbounded = { cursor: t.Optional(t.String()) };

// Existing bounded declarations remain valid during incremental adoption.
const _bounded = { cursor: t.Optional(t.String({ maxLength: 512 })) };

// The shared helper owns both the default and provider-specific bounds.
const tPaginationCursor = (maxLength = 512) => t.String({ maxLength });
const _shared = { cursor: t.Optional(tPaginationCursor()) };
const _providerCursor = { cursor: t.Optional(tPaginationCursor(4096)) };

// Optional strings that are not pagination cursors are outside the rule.
const _query = { query: t.Optional(t.String()) };

export const __requirePaginationCursorSchemaFixture = {
  _unbounded,
  _bounded,
  _shared,
  _providerCursor,
  _query,
};

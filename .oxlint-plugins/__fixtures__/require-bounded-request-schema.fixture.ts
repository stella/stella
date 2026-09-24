// Passive regression fixture for
// `require-bounded-request-schema/require-bounded-request-schema`.
//
// Each `oxlint-disable-next-line` suppresses a shape the rule MUST report; if
// the detector regresses, the directive becomes unused and the fixture lint
// fails. Everything without a directive is a shape the rule must NOT report.

import { t } from "elysia";

declare const createSafeHandler: (config: object, handler: () => void) => void;
declare const workspaceParams: (extra: object) => unknown;
declare const tDefaultVarchar: unknown;
declare const tPaginationCursor: () => unknown;

const LIMIT = 256;

// A named request schema is inspected where it is declared, including when
// the config that uses it lives in another file.
const createNoteBodySchema = t.Object({
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: bare string in a named body schema
  title: t.String(),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: minLength alone is not a bound
  note: t.Optional(t.String({ minLength: 1 })),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: date-time fraction digits are unbounded
  dueAt: t.String({ format: "date-time" }),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: array without maxItems
  tags: t.Array(tDefaultVarchar),
  // expect-clean: require-bounded-request-schema/require-bounded-request-schema
  bounded: t.String({ maxLength: LIMIT }),
  day: t.String({ format: "date" }),
  shared: tDefaultVarchar,
  cursor: t.Optional(t.String()),
  items: t.Array(t.Object({ id: t.String({ format: "uuid" }) }), {
    maxItems: 50,
  }),
});

// A same-file schema reached from a request schema is part of that request.
const noteLinkSchema = t.Object({
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: nested const reached through the query
  url: t.String(),
});

createSafeHandler(
  {
    body: createNoteBodySchema,
    query: t.Object({
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: inline query schema
      q: t.Optional(t.String()),
      link: t.Optional(noteLinkSchema),
      cursor: t.Optional(tPaginationCursor()),
    }),
    params: workspaceParams({
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: workspaceParams extra properties are the params schema
      slug: t.String(),
    }),
    headers: t.Object({
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: unions are descended into
      "x-mode": t.Union([t.Literal("a"), t.String()]),
    }),
    // Response schemas describe what the API sends, not what it accepts.
    response: t.Object({ html: t.String() }),
  },
  () => undefined,
);

// Option objects the rule cannot see into are not provably unbounded.
declare const stringOptions: { maxLength: number };
const optionsQuerySchema = t.Object({
  opaque: t.String(stringOptions),
  spread: t.String({ ...stringOptions }),
});

// Schemas that are not in a request position stay out of scope.
const noteResponseSchema = t.Object({ body: t.String() });
const internalRow = t.Object({ text: t.String(), list: t.Array(t.String()) });
const fetchInit = { body: JSON.stringify({}), headers: { accept: "json" } };
const listQueryWindow = () => t.Object({ q: t.String() });

export {
  fetchInit,
  internalRow,
  listQueryWindow,
  noteResponseSchema,
  optionsQuerySchema,
};

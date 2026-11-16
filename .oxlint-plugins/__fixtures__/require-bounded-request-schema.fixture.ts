// Passive regression fixture for
// `require-bounded-request-schema/require-bounded-request-schema`.
//
// Each `oxlint-disable-next-line` suppresses a shape the rule MUST report; if
// the detector regresses, the directive becomes unused and the fixture lint
// fails. Everything without a directive is a shape the rule must NOT report.

import * as v from "valibot";

declare const createSafeHandler: (config: object, handler: () => void) => void;
declare const workspaceParams: (extra: v.ObjectEntries) => v.GenericSchema;
declare const arrayFromQuery: (item: v.GenericSchema) => v.GenericSchema;
declare const defaultVarcharSchema: v.GenericSchema<string>;
declare const paginationCursorSchema: () => v.GenericSchema<string>;
declare const fileSchema: (options: { maxBytes: number }) => v.GenericSchema;
declare const uniqueItems: () => v.CheckAction<string[], string>;

const LIMIT = 256;

// A named request schema is inspected where it is declared, including when
// the config that uses it lives in another file.
const createNoteBodySchema = v.object({
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: bare string in a named body schema
  title: v.string(),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: minLength alone is not a bound
  note: v.optional(v.pipe(v.string(), v.minLength(1))),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: isoTimestamp fraction digits are unbounded
  dueAt: v.pipe(v.string(), v.isoTimestamp()),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: array without a maxLength step
  tags: v.array(defaultVarcharSchema),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: an imported pipe step proves no bound
  ids: v.pipe(v.array(defaultVarcharSchema), uniqueItems()),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: record without a maxEntries step
  labels: v.record(defaultVarcharSchema, v.number()),
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: file without a size step
  attachment: v.optional(v.file()),
  // expect-clean: require-bounded-request-schema/require-bounded-request-schema
  bounded: v.pipe(v.string(), v.trim(), v.maxLength(LIMIT)),
  day: v.pipe(v.string(), v.isoDate()),
  shared: defaultVarcharSchema,
  cursor: v.optional(v.string()),
  items: v.pipe(
    v.array(v.object({ id: v.pipe(v.string(), v.uuid()) })),
    v.maxLength(50),
  ),
  meta: v.pipe(v.record(defaultVarcharSchema, v.number()), v.maxEntries(20)),
  upload: fileSchema({ maxBytes: 5_000_000 }),
  kind: v.picklist(["memo", "brief"]),
});

// A same-file schema reached from a request schema is part of that request.
const noteLinkSchema = v.object({
  // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: nested const reached through the query
  url: v.string(),
});

createSafeHandler(
  {
    body: createNoteBodySchema,
    query: v.object({
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: inline query schema
      q: v.optional(v.string()),
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: a repeated query key is a list too
      tag: v.optional(arrayFromQuery(defaultVarcharSchema)),
      link: v.optional(noteLinkSchema),
      cursor: v.optional(paginationCursorSchema()),
      ids: v.optional(
        v.pipe(arrayFromQuery(defaultVarcharSchema), v.maxLength(20)),
      ),
    }),
    params: workspaceParams({
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: workspaceParams extra entries are the params schema
      slug: v.string(),
    }),
    headers: v.object({
      // oxlint-disable-next-line require-bounded-request-schema/require-bounded-request-schema -- fixture: unions are descended into
      "x-mode": v.union([v.literal("a"), v.string()]),
    }),
    // Response schemas describe what the API sends, not what it accepts.
    response: { 200: v.object({ html: v.string() }) },
  },
  () => undefined,
);

// Pipe steps the rule cannot see into are not provably unbounded.
declare const stringSteps: [v.MaxLengthAction<string, number, undefined>];
const optionsQuerySchema = v.object({
  spread: v.pipe(v.string(), ...stringSteps),
});

// Schemas that are not in a request position stay out of scope.
const noteResponseSchema = v.object({ body: v.string() });
const internalRow = v.object({ text: v.string(), list: v.array(v.string()) });
const fetchInit = { body: JSON.stringify({}), headers: { accept: "json" } };
const listQueryWindow = () => v.object({ q: v.string() });

export {
  fetchInit,
  internalRow,
  listQueryWindow,
  noteResponseSchema,
  optionsQuerySchema,
};

// Passive regression fixture for
// `require-file-transport-disposition/require-file-transport-disposition`.
//
// The rule is module-scoped: a `v.file()` or `fileSchema(...)` anywhere in the
// module puts every handler config in it under the transport requirement, so
// the "no binary field at all" case cannot be expressed here (it is a module
// with no file schema).

import * as v from "valibot";

type HandlerConfig = Record<string, unknown>;

declare const fileSchema: (options: { maxBytes: number }) => v.GenericSchema;
declare const createSafeRootHandler: (
  config: Record<string, unknown>,
  handler: () => void,
) => unknown;
declare const permissions: Record<string, readonly string[]>;

const MAX_BYTES = 5_000_000;

const uploadBodySchema = v.object({
  file: fileSchema({ maxBytes: MAX_BYTES }),
});
const prefillBodySchema = v.object({
  file: v.optional(v.pipe(v.file(), v.maxSize(MAX_BYTES))),
  text: v.pipe(v.string(), v.maxLength(256)),
});

// MUST flag: the module declares a file field, so this config's silent
// `{ type: "json" }` default would misdescribe the capability.
// oxlint-disable-next-line require-file-transport-disposition/require-file-transport-disposition -- fixture: a file-shaped handler must declare its transport
export const undeclaredFileConfig = {
  permissions,
  mcp: { type: "capability", reason: "document_processing" },
  body: uploadBodySchema,
} satisfies HandlerConfig;

// MUST flag: a config passed straight to the factory is a handler config too.
export const inlineFileHandler = createSafeRootHandler(
  // oxlint-disable-next-line require-file-transport-disposition/require-file-transport-disposition -- fixture: an inline factory config must declare its transport
  {
    permissions,
    mcp: { type: "capability", reason: "document_processing" },
    body: uploadBodySchema,
  },
  () => undefined,
);

// Allowed: the required file leg is declared, with the alternative transport.
// expect-clean: require-file-transport-disposition/require-file-transport-disposition
export const declaredFileInputConfig = {
  permissions,
  mcp: { type: "capability", reason: "document_processing" },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [] },
    alternative: {
      type: "complete",
      via: ["uploads.create", "uploads.update"],
      note: "presign, PUT the bytes, then finalize",
    },
  },
  body: uploadBodySchema,
} satisfies HandlerConfig;

// Allowed: an OPTIONAL file leg is still a declaration; it is what tells every
// client the capability keeps a JSON-only mode.
export const declaredFilelessConfig = {
  permissions,
  mcp: { type: "capability", reason: "template_authoring_ui" },
  transport: {
    type: "file-input",
    input: { field: "file", required: false, mediaTypes: [] },
    alternative: { type: "none", reason: "the bytes have no JSON form" },
  },
  body: prefillBodySchema,
} satisfies HandlerConfig;

// Allowed: an `internal` disposition never enters the capability catalog, so
// there is no client-facing transport to describe.
export const internalHandler = createSafeRootHandler(
  {
    permissions,
    mcp: { type: "internal", reason: "upload_mechanics" },
    body: uploadBodySchema,
  },
  () => undefined,
);

// Allowed: not a handler config, so the transport requirement does not apply.
export const unrelatedObject = {
  body: uploadBodySchema,
} satisfies Record<string, unknown>;

// Passive regression fixture for
// `require-file-transport-disposition/require-file-transport-disposition`.
//
// The rule is module-scoped: a `t.File()` anywhere in the module puts every
// handler config in it under the transport requirement, so the "no binary field
// at all" case cannot be expressed here (it is a module with no `t.File`).

type HandlerConfig = Record<string, unknown>;

declare const t: {
  Object: (shape: Record<string, unknown>) => unknown;
  File: (options?: unknown) => unknown;
  Optional: (schema: unknown) => unknown;
  String: (options?: unknown) => unknown;
};
declare const permissions: Record<string, readonly string[]>;

const uploadBodySchema = t.Object({ file: t.File({ maxSize: "5m" }) });
const prefillBodySchema = t.Object({
  file: t.Optional(t.File({ maxSize: "5m" })),
  text: t.String(),
});

// MUST flag: the module declares a file field, so this config's silent
// `{ type: "json" }` default would misdescribe the capability.
// oxlint-disable-next-line require-file-transport-disposition/require-file-transport-disposition -- fixture: a file-shaped handler must declare its transport
export const undeclaredFileConfig = {
  permissions,
  mcp: { type: "capability", reason: "document_processing" },
  body: uploadBodySchema,
} satisfies HandlerConfig;

// Allowed: the required file leg is declared, with the alternative transport.
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
export const internalConfig = {
  permissions,
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: uploadBodySchema,
} satisfies HandlerConfig;

// Allowed: not a handler config, so the transport requirement does not apply.
export const unrelatedObject = {
  body: uploadBodySchema,
} satisfies Record<string, unknown>;

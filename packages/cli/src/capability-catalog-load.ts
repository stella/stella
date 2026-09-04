// Loader/validator for the committed capability-catalog snapshot
// (`../capability-catalog.json`, written by the api-side exporter).
// Shared by build-time codegen (strict: a malformed snapshot panics) and the
// runtime registry-refresh path (tolerant: `null` falls back to the baked-in
// tree), so both consume the identical projection of the catalog entries.

import { panic, Result } from "better-result";
import { readFile } from "node:fs/promises";
import * as v from "valibot";

import type {
  CapabilityCatalogEntry,
  CapabilityTransport,
} from "./generate-capability-tree.js";

const CATALOG_URL = new URL("../capability-catalog.json", import.meta.url);

const jsonSchemaSchema = v.record(v.string(), v.unknown());

// Strict on the discriminant and on the file legs' shape: a catalog written by
// an exporter whose transport union has moved on fails validation here (and the
// exporter runs this parser over its own output), so the mirrored union in
// generate-capability-tree.ts cannot silently fall behind the API-side one.
const fileInputSchema = v.object({
  field: v.string(),
  required: v.boolean(),
});
const transportSchema = v.variant("type", [
  v.object({ type: v.literal("json") }),
  v.object({ type: v.literal("file-input"), input: fileInputSchema }),
  v.object({ type: v.literal("file-response") }),
  v.object({ type: v.literal("file-both"), input: fileInputSchema }),
]);

const catalogEntrySchema = v.object({
  id: v.string(),
  description: v.optional(v.string()),
  handlerKind: v.picklist(["workspace", "root", "session"]),
  access: v.picklist(["read", "write"]),
  destructive: v.boolean(),
  scope: v.string(),
  additionalScopes: v.optional(v.array(v.string())),
  transport: transportSchema,
  inputSchema: v.object({
    $defs: v.optional(jsonSchemaSchema),
    body: v.optional(jsonSchemaSchema),
    params: v.optional(jsonSchemaSchema),
    query: v.optional(jsonSchemaSchema),
  }),
});

/**
 * Narrow the validated transport to the discriminant plus the file-input shape
 * the CLI actually reads. The catalog's media types and alternative-transport
 * prose are for the MCP/describe surface and the coverage doc; carrying them
 * into the route tree would make the generated CLI churn on wording changes.
 */
const projectTransport = (
  transport: v.InferOutput<typeof transportSchema>,
): CapabilityTransport => {
  switch (transport.type) {
    case "json":
      return { type: "json" };
    case "file-response":
      return { type: "file-response" };
    case "file-input":
      return {
        type: "file-input",
        input: {
          field: transport.input.field,
          required: transport.input.required,
        },
      };
    case "file-both":
      return {
        type: "file-both",
        input: {
          field: transport.input.field,
          required: transport.input.required,
        },
      };
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/**
 * Validate a parsed catalog JSON value down to the fields the CLI consumes,
 * dropping absent optionals so `exactOptionalPropertyTypes` stays satisfied.
 * Returns `null` when the value does not match the expected entry shape.
 *
 * `inputSchema` is carried through in the artifact's `$defs`-compacted form.
 * The codegen expands it where it needs the full shape (`expand-schema-defs.ts`)
 * and re-emits the compacted form into the route map, so the CLI does not ship
 * the same recursive condition subschema a dozen times over.
 */
export const parseCapabilityCatalog = (
  raw: unknown,
): CapabilityCatalogEntry[] | null => {
  const parsed = v.safeParse(v.array(catalogEntrySchema), raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.output.map((entry) => {
    const parts: CapabilityCatalogEntry["inputSchema"] = {};
    if (entry.inputSchema.$defs !== undefined) {
      parts.$defs = entry.inputSchema.$defs;
    }
    if (entry.inputSchema.body !== undefined) {
      parts.body = entry.inputSchema.body;
    }
    if (entry.inputSchema.params !== undefined) {
      parts.params = entry.inputSchema.params;
    }
    if (entry.inputSchema.query !== undefined) {
      parts.query = entry.inputSchema.query;
    }
    const projected: CapabilityCatalogEntry = {
      id: entry.id,
      handlerKind: entry.handlerKind,
      access: entry.access,
      destructive: entry.destructive,
      scope: entry.scope,
      inputSchema: parts,
      transport: projectTransport(entry.transport),
    };
    if (entry.additionalScopes !== undefined) {
      projected.additionalScopes = entry.additionalScopes;
    }
    if (entry.description !== undefined) {
      projected.description = entry.description;
    }
    return projected;
  });
};

/**
 * Load the baked-in catalog snapshot beside this module (works from `src` at
 * codegen time and from `dist` in the published package, where the build copies
 * the JSON). Returns `null` on a missing/corrupt file so the runtime caller can
 * fall back to the baked-in route tree instead of crashing.
 */
export const loadBakedCapabilityCatalog = async (): Promise<
  CapabilityCatalogEntry[] | null
> => {
  const parsed = await Result.tryPromise({
    try: async (): Promise<unknown> =>
      JSON.parse(await readFile(CATALOG_URL, "utf-8")),
    catch: (cause) => cause,
  });
  if (Result.isError(parsed)) {
    return null;
  }
  return parseCapabilityCatalog(parsed.value);
};

// Loader/validator for the committed capability-catalog snapshot
// (`generated/capability-catalog.json`, written by the api-side exporter).
// Shared by build-time codegen (strict: a malformed snapshot panics) and the
// runtime registry-refresh path (tolerant: `null` falls back to the baked-in
// tree), so both consume the identical projection of the catalog entries.

import { Result } from "better-result";
import { readFile } from "node:fs/promises";
import * as v from "valibot";

import type { CapabilityCatalogEntry } from "./generate-capability-tree.js";

const CATALOG_URL = new URL(
  "generated/capability-catalog.json",
  import.meta.url,
);

const jsonSchemaSchema = v.record(v.string(), v.unknown());
const catalogEntrySchema = v.looseObject({
  id: v.string(),
  description: v.optional(v.string()),
  handlerKind: v.picklist(["workspace", "root", "session"]),
  access: v.picklist(["read", "write"]),
  destructive: v.boolean(),
  scope: v.string(),
  requiresFileInput: v.optional(v.boolean()),
  returnsFileResponse: v.optional(v.boolean()),
  inputSchemaTruncated: v.optional(v.boolean()),
  inputSchema: v.optional(
    v.looseObject({
      body: v.optional(jsonSchemaSchema),
      params: v.optional(jsonSchemaSchema),
      query: v.optional(jsonSchemaSchema),
    }),
  ),
});

/**
 * Validate a parsed catalog JSON value down to the fields the CLI consumes,
 * dropping absent optionals so `exactOptionalPropertyTypes` stays satisfied.
 * Returns `null` when the value does not match the expected entry shape.
 */
export const parseCapabilityCatalog = (
  raw: unknown,
): CapabilityCatalogEntry[] | null => {
  const parsed = v.safeParse(v.array(catalogEntrySchema), raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.output.map((entry) => {
    const projected: CapabilityCatalogEntry = {
      id: entry.id,
      handlerKind: entry.handlerKind,
      access: entry.access,
      destructive: entry.destructive,
      scope: entry.scope,
    };
    if (entry.description !== undefined) {
      projected.description = entry.description;
    }
    if (entry.requiresFileInput !== undefined) {
      projected.requiresFileInput = entry.requiresFileInput;
    }
    if (entry.returnsFileResponse !== undefined) {
      projected.returnsFileResponse = entry.returnsFileResponse;
    }
    if (entry.inputSchemaTruncated !== undefined) {
      projected.inputSchemaTruncated = entry.inputSchemaTruncated;
    }
    if (entry.inputSchema !== undefined) {
      const parts: NonNullable<CapabilityCatalogEntry["inputSchema"]> = {};
      if (entry.inputSchema.body !== undefined) {
        parts.body = entry.inputSchema.body;
      }
      if (entry.inputSchema.params !== undefined) {
        parts.params = entry.inputSchema.params;
      }
      if (entry.inputSchema.query !== undefined) {
        parts.query = entry.inputSchema.query;
      }
      projected.inputSchema = parts;
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

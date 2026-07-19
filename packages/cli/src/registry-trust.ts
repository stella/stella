// Trust boundary for runtime-fetched `tools/list` bodies (spec 051 S5.5). The
// runtime path turns a remote server's JSON into executable command
// definitions, so every fetched body is validated here before it can reach the
// pure `generateRouteMap`. Validation is INTERPRETED (a hand-rolled walker, no
// `Function`/`eval`/dynamic codegen; rule 1) and FAILS CLOSED (any violation is
// returned as a failure so the caller keeps the trusted baked-in tree; rule 6).
//
// The meta-schema (rule 2), the size/depth caps (rule 3), and the
// no-executable-content checks (rule 4) are enforced with the named constants
// below, exactly as the spec pins them.

import { Result } from "better-result";
import { createHash } from "node:crypto";

import type { RegistryToolListing } from "./route-types.js";

// --- Size / depth caps (spec S5.5 rule 3), named constants, not literals. ---
/** Reject a whole fetched body larger than this (bytes). */
export const MAX_LISTING_BYTES: number = 1024 * 1024; // 1 MiB
/** Reject a body advertising more tools than this. */
export const MAX_TOOLS = 200;
// Depth/enum caps bound recursion and abuse; they must clear the first-party
// registry with headroom (the `registry snapshot validates` test in
// registry-trust.test.ts fails closed if a shipped schema outgrows either cap).
// The deepest baked-in schema is `save_template` (depth 7); the largest enum is
// `set_practice_jurisdictions` (250). Both were raised from their spec S5.5
// starting values (depth 6, enum 200) once the real registry exceeded them.
/** Reject an `inputSchema` nested deeper than this (also catches `$ref` cycles). */
export const MAX_SCHEMA_DEPTH = 8;
/** Reject a single tool whose serialized `inputSchema` exceeds this (bytes). */
export const MAX_TOOL_SCHEMA_BYTES: number = 64 * 1024; // 64 KiB
/** Reject an `enum` with more members than this. */
export const MAX_ENUM = 300;
/** Reject a `properties` object with more keys than this. */
export const MAX_PROPS = 100;

/** Tool names must match this (spec S5.5 rule 2). */
export const TOOL_NAME_PATTERN: RegExp = /^[a-z][a-z0-9_]{0,63}$/u;

/** The only annotation hints a fetched listing may carry (spec S5.5 rule 2). */
const ALLOWED_ANNOTATION_KEYS: ReadonlySet<string> = new Set([
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
]);

/** The success/failure result of validating a fetched tools/list body. */
export type TrustResult =
  | { ok: true; listings: RegistryToolListing[]; toolsListHash: string }
  | { ok: false; violation: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A guard that narrows to `readonly unknown[]` (not `any[]`, which `Array.isArray`
// would introduce), keeping the walker fully typed.
const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/** Pull the `tools` array from a tools/list body (bare, `{tools}`, or envelope). */
const extractTools = (parsed: unknown): readonly unknown[] | undefined => {
  if (isUnknownArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && isUnknownArray(parsed["tools"])) {
    return parsed["tools"];
  }
  const result = isRecord(parsed) ? parsed["result"] : undefined;
  if (isRecord(result) && isUnknownArray(result["tools"])) {
    return result["tools"];
  }
  return undefined;
};

/**
 * Walk one `inputSchema` subtree enforcing the depth/enum/props caps and the
 * no-remote-`$ref` rule. Interpreted recursion with an explicit depth counter;
 * the depth cap bounds resolution and catches any `$ref` cycle (rule 4).
 * Returns a violation string, or `undefined` when the subtree is within bounds.
 */
const walkSchema = (schema: unknown, depth: number): string | undefined => {
  if (depth > MAX_SCHEMA_DEPTH) {
    return `schema nested deeper than ${MAX_SCHEMA_DEPTH}`;
  }
  if (!isRecord(schema)) {
    return undefined;
  }

  const ref = schema["$ref"];
  if (ref !== undefined && (typeof ref !== "string" || !ref.startsWith("#/"))) {
    return "only local #/... $ref is allowed";
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > MAX_ENUM) {
    return `enum larger than ${MAX_ENUM}`;
  }

  const properties = schema["properties"];
  if (isRecord(properties)) {
    if (Object.keys(properties).length > MAX_PROPS) {
      return `properties object larger than ${MAX_PROPS}`;
    }
    for (const child of Object.values(properties)) {
      const violation = walkSchema(child, depth + 1);
      if (violation !== undefined) {
        return violation;
      }
    }
  }

  const items = schema["items"];
  if (Array.isArray(items)) {
    for (const item of items) {
      const violation = walkSchema(item, depth + 1);
      if (violation !== undefined) {
        return violation;
      }
    }
  } else if (isRecord(items)) {
    const violation = walkSchema(items, depth + 1);
    if (violation !== undefined) {
      return violation;
    }
  }

  const additional = schema["additionalProperties"];
  if (isRecord(additional)) {
    return walkSchema(additional, depth + 1);
  }

  return undefined;
};

/** Validate the `annotations` field to the two known boolean hints (rule 2). */
const annotationsViolation = (annotations: unknown): string | undefined => {
  if (annotations === undefined) {
    return undefined;
  }
  if (!isRecord(annotations)) {
    return "annotations must be an object";
  }
  for (const [key, value] of Object.entries(annotations)) {
    if (!ALLOWED_ANNOTATION_KEYS.has(key)) {
      return `annotations has an unknown key '${key}'`;
    }
    if (typeof value !== "boolean") {
      return `annotations.${key} must be a boolean`;
    }
  }
  return undefined;
};

/** Project a validated entry to `RegistryToolListing`, keeping only wire fields. */
const projectListing = (
  entry: Record<string, unknown>,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): RegistryToolListing => {
  const rawAnnotations = entry["annotations"];
  if (!isRecord(rawAnnotations)) {
    return { name, description, inputSchema };
  }
  const annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};
  if (typeof rawAnnotations["readOnlyHint"] === "boolean") {
    annotations.readOnlyHint = rawAnnotations["readOnlyHint"];
  }
  if (typeof rawAnnotations["destructiveHint"] === "boolean") {
    annotations.destructiveHint = rawAnnotations["destructiveHint"];
  }
  if (typeof rawAnnotations["idempotentHint"] === "boolean") {
    annotations.idempotentHint = rawAnnotations["idempotentHint"];
  }
  if (typeof rawAnnotations["openWorldHint"] === "boolean") {
    annotations.openWorldHint = rawAnnotations["openWorldHint"];
  }
  return { name, description, inputSchema, annotations };
};

/** Validate one entry against the meta-schema + per-tool caps (rules 2, 3, 4). */
const validateEntry = (
  entry: unknown,
):
  | { ok: true; listing: RegistryToolListing }
  | { ok: false; violation: string } => {
  if (!isRecord(entry)) {
    return { ok: false, violation: "tool entry is not an object" };
  }

  const name = entry["name"];
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    return { ok: false, violation: `tool name is invalid: ${String(name)}` };
  }

  const description = entry["description"];
  if (typeof description !== "string") {
    return {
      ok: false,
      violation: `tool ${name} description must be a string`,
    };
  }

  const inputSchema = entry["inputSchema"];
  if (!isRecord(inputSchema)) {
    return {
      ok: false,
      violation: `tool ${name} inputSchema must be an object`,
    };
  }
  if (inputSchema["type"] !== "object") {
    return {
      ok: false,
      violation: `tool ${name} inputSchema.type must be "object"`,
    };
  }
  if (!isRecord(inputSchema["properties"])) {
    return {
      ok: false,
      violation: `tool ${name} inputSchema.properties must be an object`,
    };
  }

  const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema));
  if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
    return {
      ok: false,
      violation: `tool ${name} inputSchema larger than ${MAX_TOOL_SCHEMA_BYTES} bytes`,
    };
  }

  const annotationViolation = annotationsViolation(entry["annotations"]);
  if (annotationViolation !== undefined) {
    return { ok: false, violation: `tool ${name}: ${annotationViolation}` };
  }

  const schemaViolation = walkSchema(inputSchema, 1);
  if (schemaViolation !== undefined) {
    return { ok: false, violation: `tool ${name}: ${schemaViolation}` };
  }

  return {
    ok: true,
    listing: projectListing(entry, name, description, inputSchema),
  };
};

/**
 * Validate a raw fetched `tools/list` body (spec S5.5). On success returns the
 * projected `RegistryToolListing[]` plus the sha256 of the raw body; on any
 * violation returns `{ ok: false }` so the caller falls back to the baked-in
 * tree. Never throws.
 */
export const validateFetchedToolsList = (rawBody: string): TrustResult => {
  if (Buffer.byteLength(rawBody) > MAX_LISTING_BYTES) {
    return {
      ok: false,
      violation: `body larger than ${MAX_LISTING_BYTES} bytes`,
    };
  }

  const parsed = Result.try((): unknown => JSON.parse(rawBody));
  if (Result.isError(parsed)) {
    return { ok: false, violation: "body is not valid JSON" };
  }

  const tools = extractTools(parsed.value);
  if (tools === undefined) {
    return { ok: false, violation: "body has no tools array" };
  }
  if (tools.length > MAX_TOOLS) {
    return { ok: false, violation: `more than ${MAX_TOOLS} tools` };
  }

  const listings: RegistryToolListing[] = [];
  for (const entry of tools) {
    const validated = validateEntry(entry);
    if (!validated.ok) {
      return { ok: false, violation: validated.violation };
    }
    listings.push(validated.listing);
  }

  const toolsListHash = createHash("sha256").update(rawBody).digest("hex");

  return { ok: true, listings, toolsListHash };
};

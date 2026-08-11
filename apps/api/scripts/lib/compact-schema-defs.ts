// `$defs` compaction for the committed capability catalog.
//
// A handful of capabilities (the view condition/filter family) declare deeply
// recursive TypeBox unions whose expanded JSON Schema repeats the same
// condition subschema a dozen times, serializing to 140-165 KiB each. That is
// past the catalog's per-entry byte cap, and the exporter used to drop those
// schemas entirely — which cost exactly those capabilities their typed CLI
// flags, `--help`, and local `--input` validation.
//
// This pass hoists every repeated subschema into the entry's own `$defs` and
// replaces each occurrence with `{"$ref": "#/$defs/<name>"}`. Nothing is
// simplified, widened, or dropped: `expandSchemaDefs` inlines the
// refs back to the byte-identical source document, and the exporter asserts
// that round trip for every capability before it writes anything.
//
// Determinism: def names are a content hash of the subschema's serialization,
// so the same input always produces the same artifact, and an unrelated schema
// change cannot renumber every other def.

import { createHash } from "node:crypto";

import {
  DEFS_KEY,
  DEFS_REF_PREFIX,
} from "../../../../packages/cli/src/expand-schema-defs";

type JsonRecord = Record<string, unknown>;

/**
 * JSON Schema keywords whose value is a MAP of subschemas. `properties` itself
 * is not a schema, so it is never a hoist target; its values are.
 */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "dependentSchemas",
]);

/** Keywords whose value is a LIST of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

/**
 * Keywords whose value is a single subschema (or, for `items` in draft-07, a
 * list of them). A boolean value (`additionalProperties: false`) is not a
 * hoistable node and is copied through.
 */
const SCHEMA_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * Hoisting only pays off above the cost of the ref plus the `$defs` entry, so
 * small repeated fragments (`{"type":"string"}`) stay inline. The exact
 * break-even is re-checked per def after rewriting (see `savingOf`); this only
 * keeps the candidate set small.
 */
const MIN_HOISTABLE_BYTES = 200;

/** Hex characters of the content hash used in a def name. */
const DEF_NAME_HASH_LENGTH = 12;

/** Serialized cost of one `{"$ref":"#/$defs/<name>"}` node. */
const REF_NODE_BYTES =
  `{"$ref":"${DEFS_REF_PREFIX}${"x".repeat(DEF_NAME_HASH_LENGTH + 2)}"}`.length;

/** Serialized cost of one `"<name>":` key inside `$defs`, plus its separator. */
const DEF_ENTRY_OVERHEAD_BYTES = DEF_NAME_HASH_LENGTH + 2 + 4;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Def name for a subschema: `s_` plus a content hash of its serialization.
 * Same subschema, same name, in this entry and in every future regeneration.
 */
const defNameFor = (serialized: string): string =>
  `s_${createHash("sha256").update(serialized).digest("hex").slice(0, DEF_NAME_HASH_LENGTH)}`;

/**
 * Walk every SCHEMA-POSITION node reachable from `node`. Restricting the walk
 * to schema positions is what keeps the compacted artifact valid JSON Schema
 * for any other reader: a `$ref` is only ever substituted where a schema was.
 */
const visitSchemaNodes = (
  node: unknown,
  visit: (schema: JsonRecord) => void,
): void => {
  if (Array.isArray(node) || !isRecord(node)) {
    return;
  }
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      for (const child of Object.values(value)) {
        visitSchemaNodes(child, visit);
      }
      continue;
    }
    if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      for (const child of value) {
        visitSchemaNodes(child, visit);
      }
      continue;
    }
    if (!SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visitSchemaNodes(child, visit);
      }
      continue;
    }
    visitSchemaNodes(value, visit);
  }
};

/** One subschema selected for hoisting: its def name and its source node. */
type ChosenDef = { name: string; node: JsonRecord };

type RewriteContext = {
  /** Serialized subschema -> chosen def, for the defs currently hoisted. */
  chosen: ReadonlyMap<string, ChosenDef>;
  /** Def name -> number of `$ref` nodes emitted for it. */
  refCounts: Map<string, number>;
};

/**
 * Rebuild `node` with every chosen subschema replaced by a ref. `selfKey` is
 * the serialization of the def body currently being built, so a def does not
 * collapse into a ref to itself; its descendants still compact normally.
 */
const rewriteSchema = (
  node: unknown,
  context: RewriteContext,
  selfKey?: string,
): unknown => {
  if (Array.isArray(node) || !isRecord(node)) {
    return node;
  }
  const serialized = JSON.stringify(node);
  if (serialized !== selfKey) {
    const hoisted = context.chosen.get(serialized);
    if (hoisted !== undefined) {
      const { name } = hoisted;
      context.refCounts.set(name, (context.refCounts.get(name) ?? 0) + 1);
      return { $ref: `${DEFS_REF_PREFIX}${name}` };
    }
  }
  const rewritten: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      const map: JsonRecord = {};
      for (const [childKey, child] of Object.entries(value)) {
        map[childKey] = rewriteSchema(child, context);
      }
      rewritten[key] = map;
      continue;
    }
    if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      rewritten[key] = value.map((child) => rewriteSchema(child, context));
      continue;
    }
    if (!SCHEMA_KEYWORDS.has(key)) {
      rewritten[key] = value;
      continue;
    }
    rewritten[key] = Array.isArray(value)
      ? value.map((child) => rewriteSchema(child, context))
      : rewriteSchema(value, context);
  }
  return rewritten;
};

export type CapabilityInputSchemaParts = {
  body?: unknown;
  params?: unknown;
  query?: unknown;
};

export type CompactedCapabilityInputSchema = CapabilityInputSchemaParts & {
  $defs?: JsonRecord;
};

export type CompactionResult =
  | { status: "compacted"; inputSchema: CompactedCapabilityInputSchema }
  | { status: "unsupported"; reason: string };

const INPUT_PARTS = ["body", "params", "query"] as const;

/**
 * A source schema that already speaks `$ref`/`$defs` would make the compacted
 * document ambiguous: an inlined ref and a hoisted ref would be
 * indistinguishable, and expansion could no longer reproduce the source. No
 * handler config emits one today; if one ever does, the export must fail with
 * this reason rather than silently produce a schema nobody can verify.
 */
const findReservedKeyword = (node: unknown): string | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findReservedKeyword(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(node)) {
    return null;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" || key === DEFS_KEY) {
      return key;
    }
    const found = findReservedKeyword(value);
    if (found !== null) {
      return found;
    }
  }
  return null;
};

/**
 * UTF-8 bytes of `value`. The 64 KiB export cap this compactor exists to stay
 * under is measured in bytes, so every size decision here must be too: a
 * `String#length` is UTF-16 code units, and a schema carrying non-ASCII
 * descriptions or enum values would be measured short.
 */
const byteLengthOf = (value: string): number =>
  Buffer.byteLength(value, "utf8");

/**
 * Net bytes saved by keeping `name` as a def rather than inlining it back.
 *
 * Kept, the schema pays the body once inside `$defs`, one ref node per
 * occurrence, and the `$defs` key. Inlined, it pays the body once per
 * occurrence. Every ref node is a cost of keeping, including the one that
 * replaces the occurrence the def body stands in for.
 */
const savingOf = (body: unknown, refCount: number): number =>
  (refCount - 1) * byteLengthOf(JSON.stringify(body)) -
  refCount * REF_NODE_BYTES -
  DEF_ENTRY_OVERHEAD_BYTES;

/**
 * Hoist every profitably repeated subschema of one capability's input schema
 * into `$defs`. Entries with nothing worth hoisting (the large majority) come
 * back byte-identical to their input, with no `$defs` key added.
 *
 * The input is JSON round-tripped first: handler configs are TypeBox schemas,
 * which carry non-enumerable symbol metadata that `JSON.stringify` drops. The
 * round trip makes the value compacted here exactly the value that would have
 * been serialized, so the exporter's round-trip gate compares like with like.
 */
export const compactSchemaDefs = (
  inputSchema: CapabilityInputSchemaParts,
): CompactionResult => {
  // eslint-disable-next-line unicorn/prefer-structured-clone -- NOT a deep clone: the JSON projection is the point. `structuredClone` would carry through TypeBox's metadata and values JSON drops, so what gets compacted would stop matching what gets written.
  const document: CapabilityInputSchemaParts = JSON.parse(
    JSON.stringify(inputSchema),
  );
  const reserved = findReservedKeyword(document);
  if (reserved !== null) {
    return {
      reason: `input schema already uses "${reserved}"; $defs compaction cannot stay reversible over a schema that references itself. Teach compact-schema-defs.ts to carry the existing refs before shipping one`,
      status: "unsupported",
    };
  }

  const occurrences = new Map<string, { count: number; node: JsonRecord }>();
  for (const part of INPUT_PARTS) {
    visitSchemaNodes(document[part], (schema) => {
      const serialized = JSON.stringify(schema);
      const seen = occurrences.get(serialized);
      if (seen === undefined) {
        occurrences.set(serialized, { count: 1, node: schema });
        return;
      }
      seen.count += 1;
    });
  }

  // Candidates, in a deterministic order: repeated, and big enough that a ref
  // could plausibly pay for itself. Sorted by serialization so the rewrite
  // order (and therefore `$defs` insertion order) never depends on traversal
  // incidentals.
  const candidates = [...occurrences.entries()]
    .filter(
      ([serialized, { count }]) =>
        count > 1 && byteLengthOf(serialized) >= MIN_HOISTABLE_BYTES,
    )
    .sort(([left], [right]) => (left < right ? -1 : 1));
  if (candidates.length === 0) {
    return { inputSchema: document, status: "compacted" };
  }

  let chosen = new Map<string, ChosenDef>(
    candidates.map(([serialized, { node }]) => [
      serialized,
      { name: defNameFor(serialized), node },
    ]),
  );
  // Two distinct subschemas hashing to the same name would silently alias one
  // onto the other. Astronomically unlikely, cheap to rule out, catastrophic
  // if it ever happened.
  const takenNames = new Set<string>();
  for (const { name } of chosen.values()) {
    if (takenNames.has(name)) {
      return {
        reason: `def name "${name}" collides between two distinct subschemas; widen DEF_NAME_HASH_LENGTH`,
        status: "unsupported",
      };
    }
    takenNames.add(name);
  }

  // Rewrite, then drop any def that did not earn its place (referenced once
  // after nested hoisting, or too small once its own children were hoisted out)
  // and rewrite again. Each pass strictly shrinks `chosen`, so this terminates;
  // running it to a fixed point means the emitted `$defs` contains only defs
  // that save bytes, whatever the nesting.
  for (;;) {
    const refCounts = new Map<string, number>();
    const context: RewriteContext = { chosen, refCounts };
    const bodies = new Map<string, unknown>();
    for (const [serialized, { name, node }] of chosen) {
      bodies.set(name, rewriteSchema(node, context, serialized));
    }
    const compacted: CompactedCapabilityInputSchema = {};
    for (const part of INPUT_PARTS) {
      if (document[part] !== undefined) {
        compacted[part] = rewriteSchema(document[part], context);
      }
    }

    // A def's own body contributes refs to its children, so only refs from
    // OUTSIDE a def plus refs from kept defs count. Recomputing from scratch
    // each pass keeps that honest.
    const unprofitable = [...chosen].filter(
      ([, { name }]) =>
        savingOf(bodies.get(name), refCounts.get(name) ?? 0) <= 0,
    );
    if (unprofitable.length > 0) {
      const dropped = new Set(unprofitable.map(([serialized]) => serialized));
      chosen = new Map(
        [...chosen].filter(([serialized]) => !dropped.has(serialized)),
      );
      if (chosen.size === 0) {
        return { inputSchema: document, status: "compacted" };
      }
      continue;
    }

    // `$defs` last and name-sorted: the parts keep the key order they always
    // had, so an entry's diff shows the refs and the new block, nothing else.
    const defs: JsonRecord = {};
    for (const name of [...bodies.keys()].sort()) {
      defs[name] = bodies.get(name);
    }
    compacted[DEFS_KEY] = defs;
    return { inputSchema: compacted, status: "compacted" };
  }
};

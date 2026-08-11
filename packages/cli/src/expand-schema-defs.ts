// Expander for the capability catalog's `$defs`/`$ref` compaction.
//
// The api-side exporter hoists repeated subschemas of a capability's input
// schema into same-document `$defs` and replaces each occurrence with
// `{"$ref": "#/$defs/<name>"}` (see
// `apps/api/scripts/lib/compact-schema-defs.ts`). Everything downstream of the
// catalog wants the whole schema, so this module puts it back.
//
// Trust boundary: this resolves ONLY same-document `#/$defs/<name>` pointers
// out of the committed catalog, which the exporter owns. It is deliberately not
// a general `$ref` resolver: no remote refs, no `$id` base resolution, no
// pointers into arbitrary document positions, no `$ref`-alongside-siblings. The
// untrusted `tools/list` path does not come through here and is unchanged.
// Depth, node-budget, and ref-cycle bounds hold anyway, because a corrupt
// artifact must fail loudly rather than hang the CLI.
//
// One implementation, three consumers: the CLI codegen (flag derivation needs
// the full shape), the CLI at `--input` validation time, and the exporter's own
// round-trip gate. The compactor therefore can never drift from an expander
// that reads what it wrote.

/** Same-document pointer prefix; the only `$ref` form this module accepts. */
export const DEFS_REF_PREFIX = "#/$defs/";

/** The document key the exporter hoists shared subschemas into. */
export const DEFS_KEY = "$defs";

/**
 * Guard rails against a corrupt artifact. Real capability schemas nest a few
 * dozen levels and expand to a few thousand nodes, so these bounds sit far
 * above anything the exporter produces and only fire on a malformed document.
 */
const MAX_EXPANSION_DEPTH = 200;
const MAX_EXPANSION_NODES = 500_000;

/**
 * Failure sentinel. `null` cannot serve: it is a legitimate JSON Schema value
 * (`default: null`, `enum: [null]`), so a nullable return would conflate "this
 * subtree is null" with "this document is malformed".
 */
const EXPANSION_FAILED = Symbol("expansion-failed");

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `$defs` name a node points at, or `null` when the node is not the
 * `{"$ref": "#/$defs/<name>"}` shape the compactor emits. A `$ref` with
 * siblings, a non-string `$ref`, or a pointer anywhere but `$defs` is not
 * something the compactor can produce, so it fails expansion instead of being
 * resolved on a guess.
 */
const defsRefName = (node: JsonRecord): string | null => {
  const ref = node["$ref"];
  if (
    Object.keys(node).length !== 1 ||
    typeof ref !== "string" ||
    !ref.startsWith(DEFS_REF_PREFIX)
  ) {
    return null;
  }
  const name = ref.slice(DEFS_REF_PREFIX.length);
  return name.length === 0 || name.includes("/") ? null : name;
};

type ExpansionState = {
  defs: JsonRecord;
  /** Names on the current resolution path, so a `$ref` cycle is caught. */
  resolving: Set<string>;
  /** Remaining node budget, shared across the whole document. */
  budget: number;
};

const expandValue = (
  value: unknown,
  depth: number,
  state: ExpansionState,
  // `unknown` already covers the sentinel; naming it in the union would widen
  // to `unknown` anyway. Callers compare against EXPANSION_FAILED directly.
): unknown => {
  if (depth > MAX_EXPANSION_DEPTH) {
    return EXPANSION_FAILED;
  }
  state.budget -= 1;
  if (state.budget < 0) {
    return EXPANSION_FAILED;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const expanded = expandValue(item, depth + 1, state);
      if (expanded === EXPANSION_FAILED) {
        return EXPANSION_FAILED;
      }
      items.push(expanded);
    }
    return items;
  }
  if (!isRecord(value)) {
    return value;
  }
  if ("$ref" in value) {
    const name = defsRefName(value);
    if (name === null) {
      return EXPANSION_FAILED;
    }
    // An unknown name or a name already on the resolution path is a corrupt
    // artifact: the compactor only ever emits refs to defs it wrote, and a
    // subschema cannot structurally contain itself, so no cycle can arise from
    // a well-formed export.
    //
    // `Object.hasOwn` rather than a plain read: `state.defs` comes from
    // `JSON.parse` and still inherits `Object.prototype`, so a ref to
    // `#/$defs/constructor` would otherwise resolve to an inherited function
    // and be inlined as a lost subtree instead of failing loudly.
    if (!Object.hasOwn(state.defs, name) || state.resolving.has(name)) {
      return EXPANSION_FAILED;
    }
    const target = state.defs[name];
    state.resolving.add(name);
    const expanded = expandValue(target, depth + 1, state);
    state.resolving.delete(name);
    return expanded;
  }
  // Collected then built with `Object.fromEntries`, which defines own data
  // properties: a JSON-parsed document can carry an own `__proto__` key, and
  // assigning that key would invoke the prototype setter instead of storing it.
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    const expandedChild = expandValue(child, depth + 1, state);
    if (expandedChild === EXPANSION_FAILED) {
      return EXPANSION_FAILED;
    }
    entries.push([key, expandedChild]);
  }
  return Object.fromEntries(entries);
};

/**
 * Inline every `#/$defs/...` reference in a document and drop its `$defs`
 * block, yielding the schema the handler config declared. A document with
 * neither `$defs` nor `$ref` comes back unchanged (most capabilities), so this
 * is safe to run over anything the catalog carries.
 *
 * Two document shapes go through here, both `$defs`-at-the-root: a catalog
 * entry's `{ $defs?, body?, params?, query? }` input schema, and the CLI leaf's
 * synthesized `--input` wrapper schema.
 *
 * Returns `null` when the document cannot be expanded: unknown or malformed
 * ref, ref cycle, or a bound exceeded. Callers surface that as a malformed
 * snapshot rather than shipping a half-resolved schema.
 */
export const expandSchemaDefs = (
  document: Record<string, unknown>,
): Record<string, unknown> | null => {
  const rawDefs = document[DEFS_KEY];
  if (rawDefs !== undefined && !isRecord(rawDefs)) {
    return null;
  }
  const state: ExpansionState = {
    budget: MAX_EXPANSION_NODES,
    defs: rawDefs ?? {},
    resolving: new Set<string>(),
  };
  const expanded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === DEFS_KEY) {
      continue;
    }
    const expandedValue = expandValue(value, 0, state);
    if (expandedValue === EXPANSION_FAILED) {
      return null;
    }
    expanded[key] = expandedValue;
  }
  return expanded;
};

import { panic } from "better-result";

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

type ExpansionWork =
  | { type: "visit"; value: unknown; depth: number }
  | { type: "expanded"; value: unknown };

type ExpansionFrame =
  | {
      type: "array";
      source: readonly unknown[];
      nextIndex: number;
      depth: number;
      items: unknown[];
    }
  | {
      type: "object";
      source: [string, unknown][];
      nextIndex: number;
      depth: number;
      key: string;
      entries: [string, unknown][];
    }
  | { type: "ref"; name: string };

const expandValue = (value: unknown, state: ExpansionState) => {
  const frames: ExpansionFrame[] = [];
  let work: ExpansionWork = { type: "visit", value, depth: 0 };
  while (true) {
    switch (work.type) {
      case "visit": {
        if (work.depth > MAX_EXPANSION_DEPTH) {
          return EXPANSION_FAILED;
        }
        state.budget -= 1;
        if (state.budget < 0) {
          return EXPANSION_FAILED;
        }
        const current: unknown = work.value;
        const depth: number = work.depth;
        if (Array.isArray(current)) {
          const items: unknown[] = [];
          if (current.length === 0) {
            work = { type: "expanded", value: items };
            continue;
          }
          frames.push({
            type: "array",
            source: current,
            nextIndex: 1,
            depth,
            items,
          });
          work = { type: "visit", value: current.at(0), depth: depth + 1 };
          continue;
        }
        if (!isRecord(current)) {
          work = { type: "expanded", value: current };
          continue;
        }
        if ("$ref" in current) {
          const name = defsRefName(current);
          if (
            name === null ||
            !Object.hasOwn(state.defs, name) ||
            state.resolving.has(name)
          ) {
            return EXPANSION_FAILED;
          }
          state.resolving.add(name);
          // A sibling may reuse the ref only after its entire target has completed.
          frames.push({ type: "ref", name });
          work = { type: "visit", value: state.defs[name], depth: depth + 1 };
          continue;
        }
        const source = Object.entries(current);
        const first = source.at(0);
        if (first === undefined) {
          work = { type: "expanded", value: Object.fromEntries([]) };
          continue;
        }
        frames.push({
          type: "object",
          source,
          nextIndex: 1,
          depth,
          key: first[0],
          entries: [],
        });
        work = { type: "visit", value: first[1], depth: depth + 1 };
        continue;
      }
      case "expanded": {
        const frame = frames.at(-1);
        if (frame === undefined) {
          return work.value;
        }
        switch (frame.type) {
          case "ref":
            frames.pop();
            state.resolving.delete(frame.name);
            break;
          case "array":
            frame.items.push(work.value);
            if (frame.nextIndex >= frame.source.length) {
              frames.pop();
              work = { type: "expanded", value: frame.items };
            } else {
              work = {
                type: "visit",
                value: frame.source.at(frame.nextIndex),
                depth: frame.depth + 1,
              };
              frame.nextIndex += 1;
            }
            break;
          case "object": {
            frame.entries.push([frame.key, work.value]);
            const next = frame.source.at(frame.nextIndex);
            if (next === undefined) {
              frames.pop();
              // Define own data even for __proto__, preserving the original key order.
              work = {
                type: "expanded",
                value: Object.fromEntries(frame.entries),
              };
            } else {
              frame.key = next[0];
              frame.nextIndex += 1;
              work = { type: "visit", value: next[1], depth: frame.depth + 1 };
            }
            break;
          }
          default:
            frame satisfies never;
            return panic("Unknown schema expansion frame");
        }
        break;
      }
      default:
        work satisfies never;
        return panic("Unknown schema expansion work");
    }
  }
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
  const expanded: [string, unknown][] = [];
  for (const [key, value] of Object.entries(document)) {
    if (key === DEFS_KEY) {
      continue;
    }
    const expandedValue = expandValue(value, state);
    if (expandedValue === EXPANSION_FAILED) {
      return null;
    }
    expanded.push([key, expandedValue]);
  }
  return Object.fromEntries(expanded);
};

import type {
  McpStructuredTextField,
  McpTextFieldSpec,
} from "@/api/mcp/tool-types";

/**
 * Foundation helpers for `McpTextFieldSpec` (design brief plan 049, Phase 1
 * of Option B). A tool would author one `McpTextFieldSpec<TPayload>[]` per
 * response shape; `deriveTextFieldPaths` turns that list into the
 * documentation-only path list a registry entry declares today, and
 * `runTextFieldSpecs` turns it into the `McpStructuredTextField[]` push list
 * `finalizeMcpEgress` already consumes, replacing the four duplicated
 * `pushTextField`/`collectAnonymizableField` helpers module by module.
 *
 * No tool module is migrated to this in this commit (see plan 049 Phases
 * 2+); this file has no consumer yet beyond its own unit tests.
 */

/**
 * A spec list's documented `textFields` path list, mechanically derived from
 * the specs so the declaration cannot name a field the specs don't cover,
 * nor omit one they do. Typed structurally on just `path` (not the full
 * `McpTextFieldSpec<TPayload>`): `path` does not depend on `TPayload`, and
 * requiring one shared `TPayload` here would reject the realistic case of
 * inspecting specs from more than one tool (each with its own payload shape)
 * in the same call, over the contravariant-parameter variance of `items`.
 */
export const deriveTextFieldPaths = (
  specs: readonly { path: string }[],
): readonly string[] => specs.map((spec) => spec.path);

/**
 * Runs every spec's `items` extractor against the live payload and collects
 * one `McpStructuredTextField` per non-null, non-empty value (P4 skip-null,
 * centralized here instead of duplicated per module). `apply` closes over
 * the exact item `items` produced, so the write-back lands on the same
 * object reference `items` read from - as long as `items` itself reads from
 * the payload the caller is about to serve (not a copy of it), the anonymized
 * value is guaranteed to reach the served response.
 */
export const runTextFieldSpecs = <TPayload>(
  specs: readonly McpTextFieldSpec<TPayload>[],
  payload: TPayload,
): McpStructuredTextField[] => {
  const fields: McpStructuredTextField[] = [];

  for (const spec of specs) {
    const items = spec.items(payload);
    for (const [index, item] of items.entries()) {
      const value = spec.read(item, index);
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      fields.push({
        apply: (next) => {
          spec.apply(item, next, index);
        },
        value,
        workspaceId: spec.scope(item, index),
      });
    }
  }

  return fields;
};

/**
 * Authors one `McpTextFieldSpec` with a concrete item shape (`TItem`), then
 * stores it item-shape-erased as `McpTextFieldSpec<TPayload>` so a tool's
 * spec list can mix fields over different item shapes (a matter, a recent
 * entity, a contact card, ...) in one array.
 *
 * SAFETY: the erasure only ever discards the `TItem` parameter type on
 * `scope`/`read`/`apply` (from `TItem` to `unknown`) and only ever widens
 * `items`'s return element type the same way. Every value `runTextFieldSpecs`
 * later hands back into `scope`/`read`/`apply` came from calling this same
 * spec's own `items(payload)`, so it is always genuinely a `TItem`; nothing
 * outside this module ever constructs an `unknown` value and feeds it
 * through the erased type. Type erasure over a closed pair of a producer and
 * its own consumers (never an argument to attacker-controlled or otherwise
 * unrelated code) is a standard, sound existential-type encoding. (A
 * bivariant method-shorthand signature would avoid the cast entirely, but
 * this repo's `method-signature-style` lint rule forbids method shorthand in
 * type literals, so the cast is the sanctioned way to express this here.)
 */
export const defineTextFieldSpec = <TPayload, TItem>(spec: {
  path: string;
  items: (payload: TPayload) => readonly TItem[];
  scope: (item: TItem, index: number) => string;
  read: (item: TItem, index: number) => string | null | undefined;
  apply: (item: TItem, value: string, index: number) => void;
}): McpTextFieldSpec<TPayload> =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- sound item-shape erasure, see the SAFETY note above
  spec as McpTextFieldSpec<TPayload>;

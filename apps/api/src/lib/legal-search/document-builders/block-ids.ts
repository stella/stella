/**
 * Block ids for built guidance documents, derived from structure.
 *
 * A decision parser numbers blocks with a counter of one parse, so one block
 * inserted near the top renumbers everything after it. Guidance is revised
 * and re-published, and readers' marks and citations point at its blocks, so
 * an id here is a function of the block's place in the document's own
 * structure: a numbered paragraph is `p-12` wherever it moves, a section
 * heading is named by its printed label, a footnote by its mark, and
 * anything else counts only within its section. An edit in one section then
 * leaves every id outside it unchanged.
 *
 * Every id is also the block's anchor, so a fragment link and a stored mark
 * name a block the same way.
 */

import { panic } from "better-result";

import type { Block } from "@stll/legal-ast/document-ast";
import { stripDiacriticsForSlug } from "@stll/text-normalize";

/** What identifies a block before it has an id. */
export type BlockKey =
  | { type: "section"; label: string }
  | { type: "paragraph"; number: number }
  | { type: "footnote"; label: string }
  | { type: "positional" };

type BlockWithoutId<TBlock extends Block = Block> = TBlock extends Block
  ? Omit<TBlock, "id" | "anchorId">
  : never;

export type KeyedBlock = { key: BlockKey; block: BlockWithoutId };

const FRONT_SCOPE = "front";

/** Printed labels as id-safe tokens: `2.4.1` → `2-4-1`, `*` → `x`. */
const tokenOf = (label: string): string => {
  const token = stripDiacriticsForSlug(label)
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return token === "" ? "x" : token;
};

const baseIdOf = (key: BlockKey, scope: string, ordinal: number): string => {
  switch (key.type) {
    case "section": {
      return `s-${tokenOf(key.label)}`;
    }
    case "paragraph": {
      return `p-${String(key.number)}`;
    }
    case "footnote": {
      return `fn-${tokenOf(key.label)}`;
    }
    case "positional": {
      // `_` never occurs in a label token, so a positional id cannot take
      // the id of a section whose label happens to extend its scope's.
      return `${scope}_${String(ordinal)}`;
    }
    default: {
      key satisfies never;
      return panic(`Unhandled block key: ${String(key)}`);
    }
  }
};

const withId = (block: BlockWithoutId, id: string): Block => ({
  ...block,
  id,
  anchorId: id,
});

/**
 * Ids for `blocks` in document order. A label printed twice (a numbering
 * restarting in an annex) keeps its first id and the repeats take `-2`,
 * `-3`, skipping emitted ids and every structural label in the document.
 */
export const assignBlockIds = (blocks: readonly KeyedBlock[]): Block[] => {
  const reserved = new Set(
    blocks.flatMap(({ key }) =>
      key.type === "positional" ? [] : [baseIdOf(key, FRONT_SCOPE, 0)],
    ),
  );
  const emitted = new Set<string>();
  const suffixes = new Map<string, number>();
  let scope = FRONT_SCOPE;
  let ordinal = 0;
  return blocks.map(({ block, key }) => {
    if (key.type === "positional") {
      ordinal += 1;
    }
    const base = baseIdOf(key, scope, ordinal);
    let id = base;
    if (emitted.has(id)) {
      let suffix = suffixes.get(base) ?? 1;
      do {
        suffix += 1;
        id = `${base}-${String(suffix)}`;
      } while (reserved.has(id) || emitted.has(id));
      suffixes.set(base, suffix);
    }
    emitted.add(id);
    if (key.type === "section") {
      scope = id;
      ordinal = 0;
    }
    return withId(block, id);
  });
};

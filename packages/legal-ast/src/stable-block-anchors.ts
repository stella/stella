/**
 * Stable decision block anchors.
 *
 * Parsers number blocks as they read them (`p-12`, `h-3`, `op1-p4`), so the
 * same anchor names different text after any reparse that splits, joins or
 * reclassifies a block earlier in the document. A link that carries the old
 * anchor then lands on another paragraph without any visible failure.
 *
 * Ingestion replaces every positional anchor with one derived from the block
 * itself: `n<court number>` for a paragraph the court numbered, otherwise
 * `x<hash of its words>`. Neither shape can match a positional anchor, so a
 * legacy anchor and a stable one never name different blocks, and replacing
 * twice changes nothing. Publisher anchors (CJEU point numbers, Find Case Law
 * eIds, note ids) are not positional and are kept. A supplement or opinion
 * prefix (`dissent-<id>-`, `op1-`) is kept in front of the stable part.
 *
 * Only `anchorId` changes. Block `id` stays the parse's own identity: citation
 * scopes, table-cell pieces and projection digests are keyed by it within one
 * stored document, and nothing outside that document stores it.
 *
 * Server-only: the hash is synchronous.
 */

import { panic } from "better-result";

import { sha256Hex } from "@stll/sha256/node";

import { courtParagraphNumber } from "./court-paragraph-number.js";
import type { Block, DocumentAst } from "./document-ast.js";
import { plainTextOf } from "./document-ast.js";
import { hasInlineChildren } from "./inline.js";
import type { Inline } from "./inline.js";
import { readerTextQuoteKey } from "./reader-text-quote.js";

/** The block kinds a parser numbers: paragraph, heading, table. */
const POSITIONAL_ANCHOR_KINDS = ["p", "h", "t"] as const;

type PositionalAnchorKind = (typeof POSITIONAL_ANCHOR_KINDS)[number];

/**
 * An optional prefix ending in `-`, a kind letter, an optional `-`, the
 * block's ordinal, and any `-<n>` repeats `withUniqueBlockIdentities` added.
 */
const POSITIONAL_ANCHOR = /^((?:.*-)?)([pht])-?(\d+)((?:-\d+)*)$/u;

type PositionalBlockAnchorOptions = {
  kind: PositionalAnchorKind;
  ordinal: number;
  /** A supplement or opinion prefix, ending in `-`. */
  prefix?: string | undefined;
};

/**
 * The anchor a parser gives a block it numbers. Ingestion replaces it
 * (`withStableBlockAnchors`), so a parser never needs another shape.
 */
export const positionalBlockAnchor = ({
  kind,
  ordinal,
  prefix = "",
}: PositionalBlockAnchorOptions): string =>
  `${prefix}${kind}-${String(ordinal)}`;

/** The prefix of a positional anchor, or null when the anchor is not one. */
const positionalPrefixOf = (anchorId: string): string | null => {
  const match = POSITIONAL_ANCHOR.exec(anchorId);
  return match === null ? null : (match[1] ?? "");
};

export const isPositionalBlockAnchor = (anchorId: string): boolean =>
  positionalPrefixOf(anchorId) !== null;

/**
 * A stable anchor: optional prefix, `n<number>` (with `x<hash>` when the
 * number repeats) or `x<hash>`, repeats.
 */
const STABLE_ANCHOR =
  /^((?:.*-)?)(?:n\d+(?:x[0-9a-f]{10})?|x[0-9a-f]{10})((?:-\d+)*)$/u;

/**
 * The supplement or opinion prefix of a positional or stable anchor (`""`
 * for the main text), or null for a publisher anchor, whose shape says
 * nothing about where it sits.
 */
export const blockAnchorPrefix = (anchorId: string): string | null =>
  positionalPrefixOf(anchorId) ?? STABLE_ANCHOR.exec(anchorId)?.[1] ?? null;

/**
 * Ten hex characters (40 bits) of the SHA-256 of `text`. Two blocks of one
 * document that still collide are told apart by the repeat suffix, so the
 * hash only has to make a collision rare, not impossible.
 */
const STABLE_HASH_HEX_LENGTH = 10;

const shortHash = (text: string): string =>
  sha256Hex(text).slice(0, STABLE_HASH_HEX_LENGTH);

/**
 * The words a stable anchor is derived from, whitespace-free like a reader
 * quote key, so a reparse that only respaces or rewraps a block keeps it.
 * A block's type is not part of it: a heading read as a paragraph keeps its
 * anchor.
 */
export const blockAnchorText = (block: Block): string => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return readerTextQuoteKey(plainTextOf(block.inlines));
    case "table":
      return block.rows
        .map((row) => row.map((cell) => readerTextQuoteKey(cell.plainText)))
        .map((cells) => cells.join("\u001F"))
        .join("\u001E");
    case "image":
      return block.src;
    default:
      block satisfies never;
      return panic(`Unhandled block type: ${String(block)}`);
  }
};

/** The court-numbered group a block belongs to, or null for an unnumbered one. */
const numberedGroupOf = (block: Block, prefix: string): string | null => {
  const number = courtParagraphNumber(block);
  return number === null ? null : `${prefix}n${String(number)}`;
};

/**
 * A number the court printed once is the anchor itself. A number it printed
 * more than once (numbering restarted without a prefix) cannot tell its
 * blocks apart by position without handing one block's anchor to another
 * when a block is inserted, so every block of that group adds its words.
 */
const stableBaseOf = (
  block: Block,
  prefix: string,
  repeatedGroups: ReadonlySet<string>,
): string => {
  const group = numberedGroupOf(block, prefix);
  if (group === null) {
    return `${prefix}x${shortHash(blockAnchorText(block))}`;
  }
  return repeatedGroups.has(group)
    ? `${group}x${shortHash(blockAnchorText(block))}`
    : group;
};

const remapHref = (
  href: string,
  renamed: ReadonlyMap<string, string>,
): string => {
  if (!href.startsWith("#")) {
    return href;
  }
  // Positional anchors are minted URL-safe, so the raw fragment is the key.
  const target = renamed.get(href.slice(1));
  return target === undefined ? href : `#${target}`;
};

const remapInlines = (
  inlines: readonly Inline[],
  renamed: ReadonlyMap<string, string>,
): Inline[] =>
  inlines.map((node): Inline => {
    const withChildren = hasInlineChildren(node)
      ? { ...node, children: remapInlines(node.children, renamed) }
      : node;
    switch (withChildren.type) {
      case "link":
        return { ...withChildren, href: remapHref(withChildren.href, renamed) };
      case "citation":
      case "page-anchor":
        return withChildren.href === undefined
          ? withChildren
          : { ...withChildren, href: remapHref(withChildren.href, renamed) };
      case "text":
      case "bold":
      case "italic":
      case "underline":
      case "superscript":
      case "subscript":
      case "line-break":
        return withChildren;
      default:
        withChildren satisfies never;
        return panic(`Unhandled inline type: ${String(withChildren)}`);
    }
  });

const remapBlockInlines = (
  block: Block,
  renamed: ReadonlyMap<string, string>,
): Block => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return { ...block, inlines: remapInlines(block.inlines, renamed) };
    case "table":
      return {
        ...block,
        rows: block.rows.map((row) =>
          row.map((cell) => ({
            ...cell,
            inlines: remapInlines(cell.inlines, renamed),
          })),
        ),
      };
    case "image":
      return block;
    default:
      block satisfies never;
      return panic(`Unhandled block type: ${String(block)}`);
  }
};

/**
 * The document with every positional anchor replaced by a stable one, and
 * every in-document `#anchor` link following its target.
 *
 * A court number printed more than once adds each block's words. Stable
 * anchors that still repeat (identical paragraphs) take `-2`, `-3` in
 * document order, never a value another block already holds. A document with no positional anchor comes back as
 * the same object.
 */
export const withStableBlockAnchors = (ast: DocumentAst): DocumentAst => {
  const read = ast.blocks.map((block) => ({
    block,
    prefix: positionalPrefixOf(block.anchorId),
  }));
  if (read.every(({ prefix }) => prefix === null)) {
    return ast;
  }
  // Kept anchors are claimed first, so a stable anchor never takes one.
  const used = new Set(
    read.flatMap(({ block, prefix }) =>
      prefix === null ? [block.anchorId] : [],
    ),
  );
  const groupSizes = new Map<string, number>();
  for (const { block, prefix } of read) {
    const group = prefix === null ? null : numberedGroupOf(block, prefix);
    if (group !== null) {
      groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
    }
  }
  const repeatedGroups = new Set(
    [...groupSizes].flatMap(([group, size]) => (size > 1 ? [group] : [])),
  );
  const renamed = new Map<string, string>();
  const claim = (base: string): string => {
    let candidate = base;
    for (let repeat = 2; used.has(candidate); repeat += 1) {
      candidate = `${base}-${String(repeat)}`;
    }
    used.add(candidate);
    return candidate;
  };
  const anchored = read.map(({ block, prefix }): Block => {
    if (prefix === null) {
      return block;
    }
    const anchorId = claim(stableBaseOf(block, prefix, repeatedGroups));
    renamed.set(block.anchorId, anchorId);
    return { ...block, anchorId };
  });
  return {
    ...ast,
    blocks: anchored.map((block) => remapBlockInlines(block, renamed)),
  };
};

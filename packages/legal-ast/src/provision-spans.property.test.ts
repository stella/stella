import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Block } from "./document-ast.js";
import {
  governingWording,
  provisionPreviewBlocks,
} from "./provision-preview.js";
import { E_SBIRKA_ANCHORS } from "./statute-anchor-scheme.js";

/**
 * Anchor spans over arbitrary provision outlines.
 *
 * A provision is a tree the publisher states: numbered units (subsections,
 * letters, points) and, at any position among a unit's children, wording it
 * numbers nowhere (a lead-in, an alternative, a closing sentence). The
 * reader holds it as a flat block stream. Whatever the shape, every block
 * belongs to exactly one innermost anchor span, a read by an anchor returns
 * exactly what the tree files under that anchor, and the wording an ancestor
 * files around it comes back beside it. Rows parsed before unnumbered
 * wording carried its parent's path (bare `frag_…`) must still lose nothing
 * a reader of the unit needs.
 */

type Shape = { children: readonly ShapeChild[] };
type ShapeChild = "unnumbered" | Shape;

const shape: fc.Arbitrary<Shape> = fc.letrec<{ node: Shape }>((tie) => ({
  node: fc.record({
    children: fc.array(
      fc.oneof(
        { depthSize: "small", maxDepth: 3 },
        fc.constant<ShapeChild>("unnumbered"),
        tie("node"),
      ),
      { maxLength: 4 },
    ),
  }),
})).node;

type Node = {
  anchor: string;
  /** Blocks this unit owns: its own, then every descendant's. */
  filed: Block[];
  /** Its own block and its direct unnumbered wording. */
  wording: Block[];
  /** Direct unnumbered wording before its first and after its last numbered child. */
  outerWording: Block[];
  ancestors: Node[];
};

const KINDS = ["odst", "pism", "bod"] as const;
const LETTERS = "abcdefghij";

const paragraph = (anchorId: string): Block => ({
  anchorId,
  id: anchorId,
  inlines: [{ text: `t:${anchorId}`, type: "text" }],
  plainText: `t:${anchorId}`,
  type: "paragraph",
});

const heading = (anchorId: string): Block => ({
  anchorId,
  id: anchorId,
  inlines: [{ text: anchorId, type: "text" }],
  level: 3,
  plainText: anchorId,
  type: "heading",
});

type Outline = { blocks: Block[]; units: Node[] };

/**
 * The provision `par_1` as a block stream, between a provision before it and
 * one after it, with unnumbered wording anchored `filed` (under its parent's
 * path) or `unfiled` (a bare `frag_…`).
 */
const outline = (root: Shape, filing: "filed" | "unfiled"): Outline => {
  const blocks: Block[] = [heading("par_0"), paragraph("par_0-odst_1")];
  const units: Node[] = [];
  let fragments = 1000;
  const provision: Node = {
    anchor: "par_1",
    filed: [],
    wording: [],
    outerWording: [],
    ancestors: [],
  };
  blocks.push(heading("par_1"));

  const walk = (node: Node, children: readonly ShapeChild[], depth: number) => {
    const numbered = children.flatMap((child, index) =>
      child === "unnumbered" ? [] : [index],
    );
    let ordinal = 0;
    for (const [index, child] of children.entries()) {
      if (child === "unnumbered") {
        fragments += 1;
        const block = paragraph(
          filing === "filed"
            ? `${node.anchor}-frag_${fragments}`
            : `frag_${fragments}`,
        );
        blocks.push(block);
        for (const owner of [node, ...node.ancestors]) {
          owner.filed.push(block);
        }
        node.wording.push(block);
        if (
          numbered.length === 0 ||
          index < (numbered.at(0) ?? 0) ||
          index > (numbered.at(-1) ?? 0)
        ) {
          node.outerWording.push(block);
        }
        continue;
      }
      ordinal += 1;
      const kind = KINDS[Math.min(depth, KINDS.length - 1)] ?? "bod";
      const value =
        kind === "pism"
          ? (LETTERS[ordinal - 1] ?? `z${ordinal}`)
          : `${ordinal}`;
      const unit: Node = {
        anchor: `${node.anchor}-${kind}_${value}`,
        filed: [],
        wording: [],
        outerWording: [],
        ancestors: [node, ...node.ancestors],
      };
      const own = paragraph(unit.anchor);
      blocks.push(own);
      for (const owner of [unit, node, ...node.ancestors]) {
        owner.filed.push(own);
      }
      unit.wording.push(own);
      units.push(unit);
      walk(unit, child.children, depth + 1);
    }
  };
  walk(provision, root.children, 0);
  blocks.push(heading("par_2"), paragraph("par_2-odst_1"));
  return { blocks, units };
};

const statuteOf = (blocks: readonly Block[]) => ({
  blocks,
  scheme: E_SBIRKA_ANCHORS,
});

const read = (blocks: readonly Block[], unit: Node) => {
  const target = { provisionAnchorId: "par_1", citedAnchorId: unit.anchor };
  return {
    span: provisionPreviewBlocks(statuteOf(blocks), target) ?? [],
    governing: governingWording(statuteOf(blocks), target),
  };
};

const ids = (blocks: readonly Block[]) => blocks.map((block) => block.id);

describe("anchor spans over a provision outline", () => {
  test("filed wording: a read returns exactly what the tree files under the anchor", () => {
    assertProperty(
      "filed wording: a read returns exactly what the tree files under the anchor",
      fc.property(shape, (root) => {
        const { blocks, units } = outline(root, "filed");
        for (const unit of units) {
          expect({
            unit: unit.anchor,
            span: ids(read(blocks, unit).span),
          }).toEqual({ unit: unit.anchor, span: ids(unit.filed) });
        }
      }),
    );
  });

  test("filed wording: every block has exactly one innermost span", () => {
    assertProperty(
      "filed wording: every block has exactly one innermost span",
      fc.property(shape, (root) => {
        const { blocks, units } = outline(root, "filed");
        const spans = units.map(
          (unit) => new Set(ids(read(blocks, unit).span)),
        );
        // Spans nest or are disjoint, so a block's smallest span is unique.
        for (const left of spans) {
          for (const right of spans) {
            const shared = [...left].filter((id) => right.has(id));
            expect(
              shared.length === 0 ||
                shared.length === left.size ||
                shared.length === right.size,
            ).toBe(true);
          }
        }
      }),
    );
  });

  test("filed wording: an ancestor's wording comes back beside the unit, placed where it stands", () => {
    assertProperty(
      "filed wording: an ancestor's wording comes back beside the unit, placed where it stands",
      fc.property(shape, (root) => {
        const { blocks, units } = outline(root, "filed");
        for (const unit of units) {
          const own = blocks.findIndex(
            (block) => block.anchorId === unit.anchor,
          );
          const expected = unit.ancestors
            .flatMap((ancestor) => ancestor.wording)
            .filter((block) => block.type !== "heading")
            .toSorted(
              (left, right) => blocks.indexOf(left) - blocks.indexOf(right),
            )
            .map((block) => [
              blocks.indexOf(block) < own ? "lead-in" : "closing",
              block.id,
            ]);
          expect({
            unit: unit.anchor,
            governing: read(blocks, unit).governing.map(
              ({ block, position }) => [position, block.id],
            ),
          }).toEqual({ unit: unit.anchor, governing: expected });
        }
      }),
    );
  });

  test("unfiled wording: a read never silently drops what governs the unit", () => {
    assertProperty(
      "unfiled wording: a read never silently drops what governs the unit",
      fc.property(shape, (root) => {
        const { blocks, units } = outline(root, "unfiled");
        for (const unit of units) {
          const { span, governing } = read(blocks, unit);
          const returned = new Set([
            ...ids(span),
            ...governing.map(({ block }) => block.id),
          ]);
          // What the unit owns, its ancestors' own blocks, and the wording
          // they print before or after their lists.
          const needed = [
            ...unit.filed,
            ...unit.ancestors.flatMap((ancestor) =>
              ancestor.wording.filter(
                (block) =>
                  !block.anchorId.startsWith("frag_") ||
                  ancestor.outerWording.includes(block),
              ),
            ),
          ];
          const missing = ids(needed).filter((id) => !returned.has(id));
          expect({ unit: unit.anchor, missing }).toEqual({
            unit: unit.anchor,
            missing: [],
          });
          // And a read never hands over a numbered unit it does not own.
          const foreign = span.filter(
            (block) =>
              !block.anchorId.startsWith("frag_") &&
              !unit.filed.includes(block),
          );
          expect(ids(foreign)).toEqual([]);
        }
      }),
    );
  });
});

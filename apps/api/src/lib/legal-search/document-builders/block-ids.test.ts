import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { assignBlockIds } from "./block-ids";
import type { KeyedBlock } from "./block-ids";

const heading = (label: string): KeyedBlock => ({
  key: { type: "section", label },
  block: {
    type: "heading",
    level: 2,
    inlines: [{ type: "text", text: label }],
    plainText: label,
  },
});

test("reserves structural labels before allocating duplicate suffixes", () => {
  const blocks = assignBlockIds(["1", "1", "1.2"].map(heading));
  expect(blocks.map(({ id }) => id)).toEqual(["s-1", "s-1-3", "s-1-2"]);
  expect(new Set(blocks.map(({ id }) => id)).size).toBe(3);
});

const label = fc.oneof(
  fc.string(),
  fc.constantFrom("1", "1.2", "1-2", "1.3", "", "*", "é", "e"),
  fc
    .array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 })
    .map((parts) => parts.join(".")),
);

test("any label sequence receives unique block ids and matching anchors", () => {
  assertProperty(
    "any label sequence receives unique block ids and matching anchors",
    fc.property(fc.array(label, { maxLength: 100 }), (labels) => {
      const blocks = assignBlockIds(labels.map(heading));
      expect(new Set(blocks.map(({ id }) => id)).size).toBe(labels.length);
      for (const block of blocks) {
        expect(block.anchorId).toBe(block.id);
      }
    }),
  );
});

const key = fc.oneof(
  label.map((value) => ({ type: "section" as const, label: value })),
  label.map((value) => ({ type: "footnote" as const, label: value })),
  fc
    .integer({ min: 1, max: 4 })
    .map((number) => ({ type: "paragraph" as const, number })),
  fc.constant({ type: "positional" as const }),
);

test("mixed structural and positional keys receive unique ids", () => {
  assertProperty(
    "mixed structural and positional keys receive unique ids",
    fc.property(fc.array(key, { maxLength: 100 }), (keys) => {
      const blocks = assignBlockIds(
        keys.map((blockKey) => ({
          key: blockKey,
          block: { type: "paragraph", inlines: [], plainText: "" },
        })),
      );
      expect(new Set(blocks.map(({ id }) => id)).size).toBe(keys.length);
    }),
  );
});

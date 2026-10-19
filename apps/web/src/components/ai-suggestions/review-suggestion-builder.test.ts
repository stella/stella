import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { buildPreview } from "@/components/ai-suggestions/review-suggestion-builder";

describe("replacement preview literal matching", () => {
  test.each([
    ["😀 Čapkově návrhu Čapkově", "Čapkově", "😀 ", " návrhu Čapkově"],
    ["[a+b] aab", "[a+b]", "", " aab"],
    ["Čapek Capek", "capek", "Čapek Capek", ""],
    ["aaa", "aa", "", "a"],
    ["😀", "😀", "", ""],
    ["", "term", "", ""],
    ["left \ud801 right", "\ud800", "left ", " right"],
    ["😀", "\ud83d", "😀", ""],
  ])(
    "locates the first case-sensitive literal in %s",
    (text, find, contextBefore, contextAfter) => {
      expect(
        buildPreview(
          {
            id: "operation",
            type: "replaceInBlock",
            blockId: "b",
            find,
            replace: "NEW",
          },
          new Map([["b", { id: "b", text }]]),
        ),
      ).toEqual({
        type: "replaceInBlock",
        contextBefore,
        before: find.toWellFormed(),
        after: "NEW",
        contextAfter,
      });
    },
  );

  test("returns no preview when the snapshot block is absent", () => {
    expect(
      buildPreview(
        {
          id: "operation",
          type: "replaceInBlock",
          blockId: "b",
          find: "term",
          replace: "NEW",
        },
        new Map(),
      ),
    ).toBeNull();
  });
});

const previewText = fc.string({
  unit: fc.constantFrom(
    "a",
    "A",
    "Č",
    "ě",
    "ß",
    "ﬁ",
    "Σ",
    "ς",
    "1",
    "[",
    "]",
    "+",
    ".",
    " ",
    "\n",
    "\u030c",
    "😀",
    "\ud800",
    "\ud801",
  ),
  size: "medium",
});

test("preview retains the first scalar substring and bounded context", () => {
  assertProperty(
    "preview retains the first scalar substring and bounded context",
    fc.property(
      previewText,
      previewText,
      fc.boolean(),
      fc.nat(160),
      (rawText, rawFind, sliceFind, offset) => {
        const text = rawText.toWellFormed();
        const find = (
          sliceFind
            ? rawText.slice(
                offset % Math.max(rawText.length, 1),
                (offset % Math.max(rawText.length, 1)) + 12,
              )
            : rawFind
        ).toWellFormed();
        fc.pre(find.length > 0);
        const index = text.indexOf(find);
        const expected =
          index === -1
            ? { contextBefore: text.slice(0, 60), contextAfter: "" }
            : {
                contextBefore: text.slice(Math.max(0, index - 60), index),
                contextAfter: text.slice(
                  index + find.length,
                  index + find.length + 60,
                ),
              };
        expect(
          buildPreview(
            {
              id: "operation",
              type: "replaceInBlock",
              blockId: "b",
              find,
              replace: "NEW",
            },
            new Map([["b", { id: "b", text: rawText }]]),
          ),
        ).toEqual({
          type: "replaceInBlock",
          before: find,
          after: "NEW",
          ...expected,
        });
      },
    ),
  );
});

test("bounds preview context around a long literal find", () => {
  const find = "Čapek".repeat(256);
  const text = "a".repeat(100) + find + "z".repeat(100);
  expect(
    buildPreview(
      {
        id: "operation",
        type: "replaceInBlock",
        blockId: "b",
        find,
        replace: "NEW",
      },
      new Map([["b", { id: "b", text }]]),
    ),
  ).toEqual({
    type: "replaceInBlock",
    contextBefore: "a".repeat(60),
    before: find,
    after: "NEW",
    contextAfter: "z".repeat(60),
  });
});

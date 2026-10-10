import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import {
  findAnchoredSpan,
  isSpanReplacementBalanced,
  spliceSpanProposal,
} from "@/api/handlers/chat/messages/revisions/span-proposal";

const content = toPersistedChatMessageContentV3({
  data: [
    { type: "text", content: "Hello " },
    {
      type: "tool-call",
      id: "call",
      name: "boe_search_legislation",
      arguments: "{}",
      state: "complete",
    },
    { type: "text", content: "world 🌍" },
  ],
});

describe("anchored answer proposals", () => {
  test("global text offsets splice one part and retain every other part", () => {
    const anchor = findAnchoredSpan({
      content,
      start: 6,
      end: 11,
      selectedTextHash: sha256Hex("world"),
    });
    expect(anchor?.selected).toBe("world");
    if (!anchor) {
      throw new TypeError("Expected a valid anchor");
    }
    const proposal = spliceSpanProposal({
      content,
      anchor,
      replacement: "everyone",
    });
    expect(proposal.data.slice(0, 2)).toEqual(content.data.slice(0, 2));
    expect(proposal.data.at(2)).toEqual({
      type: "text",
      content: "everyone 🌍",
    });
    expect(proposal.metadata).toEqual(content.metadata);
  });

  test.each([
    { start: 6, end: 11, text: "wrong" },
    { start: 5, end: 8, text: " wo" },
    { start: 6, end: 20, text: "world 🌍" },
    { start: 6, end: 6, text: "" },
  ])(
    "rejects an outdated or cross-part anchor $start..$end",
    ({ start, end, text }) => {
      expect(
        findAnchoredSpan({
          content,
          start,
          end,
          selectedTextHash: sha256Hex(text),
        }),
      ).toBeNull();
    },
  );
});

describe("Markdown replacement boundaries", () => {
  test.each([
    { source: "hello world", start: 0, end: 6 },
    { source: "hello world", start: 3, end: 8 },
    { source: "hello world", start: 6, end: 11 },
    { source: "hello world", start: 0, end: 11 },
    { source: "left\n\n**right**", start: 0, end: 4 },
    { source: "**left**\n\nright", start: 10, end: 15 },
  ])("permits empty replacements at $start..$end in $source", (options) => {
    expect(isSpanReplacementBalanced({ ...options, replacement: "" })).toBe(
      true,
    );
  });
  test("every contiguous plain-text deletion preserves the remaining structure", () => {
    const source = "abcdef";
    for (let start = 0; start < source.length; start += 1) {
      for (let end = start + 1; end <= source.length; end += 1) {
        expect(
          isSpanReplacementBalanced({ source, start, end, replacement: "" }),
        ).toBe(true);
      }
    }
  });
  test.each([
    { source: "hello world", start: 0 },
    { source: "hello world", start: 5 },
    { source: "hello world", start: 11 },
    { source: "**left**\n\nright", start: 0 },
    { source: "**left**\n\nright", start: 8 },
    { source: "**left**\n\nright", start: 10 },
    { source: "**left**\n\nright", start: 15 },
  ])(
    "permits plain-text insertion at boundary $start in $source",
    (options) => {
      expect(
        isSpanReplacementBalanced({
          ...options,
          end: options.start,
          replacement: "added",
        }),
      ).toBe(true);
    },
  );
  test.each([
    { source: "**bold** tail", start: 0, end: 1, replacement: "" },
    { source: "`code` tail", start: 0, end: 1, replacement: "" },
    { source: "left\n\nright", start: 4, end: 6, replacement: "" },
    { source: "**bold** tail", start: 1, end: 1, replacement: "added" },
  ])(
    "rejects boundary edits that change surrounding structure in $source",
    (options) => {
      expect(isSpanReplacementBalanced(options)).toBe(false);
    },
  );
  test.each([
    "plain text",
    "**bold**",
    "`code`",
    "``a ` b``",
    "**bold *nested***",
    "Multiply 2 * 3",
    "**open",
    "`open",
    "[label](https://example.com",
    "[label](https://example.com)",
    "[label](<https://example.test/a(b>)",
    "[label](<https://example.test/a)b>)",
    '[label](https://example.test "Title with (unmatched parenthesis")',
    "[label](https://example.test 'Title with )unmatched parenthesis')",
  ])("accepts balanced inline replacement %s", (replacement) => {
    expect(
      isSpanReplacementBalanced({
        source: "a selected word",
        start: 2,
        end: 10,
        replacement,
      }),
    ).toBe(true);
  });
  test.each(["new\nblock", "```ts\ncode"])(
    "rejects unbalanced or block replacement %s",
    (replacement) => {
      expect(
        isSpanReplacementBalanced({
          source: "a selected word",
          start: 2,
          end: 10,
          replacement,
        }),
      ).toBe(false);
    },
  );
  test("accepts complete fenced blocks but rejects table cell separators", () => {
    expect(
      isSpanReplacementBalanced({
        source: "old",
        start: 0,
        end: 3,
        replacement: "```ts\nconst x = 1;\n```",
      }),
    ).toBe(true);
    expect(
      isSpanReplacementBalanced({
        source: "| old | cell |",
        start: 2,
        end: 5,
        replacement: "a | b",
      }),
    ).toBe(false);
  });
  test("retains enclosing bold syntax and permits intraword underscores", () => {
    expect(
      isSpanReplacementBalanced({
        source: "**Hello** world",
        start: 2,
        end: 7,
        replacement: "Hi",
      }),
    ).toBe(true);
    expect(
      isSpanReplacementBalanced({
        source: "**Hello** world",
        start: 2,
        end: 7,
        replacement: "**Hi**",
      }),
    ).toBe(true);
    expect(
      isSpanReplacementBalanced({
        source: "a selected word",
        start: 2,
        end: 10,
        replacement: "some_identifier",
      }),
    ).toBe(true);
  });
  test("rejects an unclosed fenced block even when the entire source is replaced", () => {
    expect(
      isSpanReplacementBalanced({
        source: "old",
        start: 0,
        end: 3,
        replacement: "```ts\ncode",
      }),
    ).toBe(false);
  });
  test.each([
    { source: "- [ ] old item", start: 3, end: 4, replacement: "x" },
    { source: "```ts\nold\n```", start: 3, end: 5, replacement: "js" },
    {
      source: '[old](https://example.test "Title")',
      start: 28,
      end: 33,
      replacement: "Changed title",
    },
  ])("preserves enclosing semantic attributes in $source", (options) => {
    expect(isSpanReplacementBalanced(options)).toBe(false);
  });
});

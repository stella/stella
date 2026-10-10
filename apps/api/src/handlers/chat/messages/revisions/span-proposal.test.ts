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
      name: "search",
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

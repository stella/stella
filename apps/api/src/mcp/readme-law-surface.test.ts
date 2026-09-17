import { describe, expect, test } from "bun:test";

import { LAW_MCP_TOOL_DISPOSITION } from "@/api/mcp/static-tool-definitions";

const README_PATH = "apps/api/src/mcp/README.md";

/**
 * The README spells its tool count in prose. An unspelled word fails loudly
 * instead of matching a default, so a reworded claim is a test failure rather
 * than a silently unchecked sentence.
 */
const COUNT_WORDS = {
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
} as const;

const isCountWord = (word: string): word is keyof typeof COUNT_WORDS =>
  word in COUNT_WORDS;

const lawSurfaceToolNames = Object.entries(LAW_MCP_TOOL_DISPOSITION)
  .filter(([, disposition]) => disposition === "corpus")
  .map(([name]) => name);

const LAW_TOOL_CLAIM =
  /Exactly (?<count>\w+) read tools\s*\((?<tools>[^)]*)\)/u;

const readme = await Bun.file(new URL("README.md", import.meta.url)).text();
const claim = LAW_TOOL_CLAIM.exec(readme)?.groups;

describe("mcp README law surface", () => {
  test("the README still claims a law tool count and list", () => {
    expect(
      claim,
      `${README_PATH} no longer contains an "Exactly <count> read tools (...)" claim for the /mcp-law audience; restore that sentence so this guard can check it against LAW_MCP_TOOL_DISPOSITION`,
    ).toBeDefined();
  });

  test("the stated count is the number of law-surface tools", () => {
    const word = claim?.["count"] ?? "";
    expect(
      isCountWord(word),
      `${README_PATH} spells the law tool count as "${word}", which this guard cannot read; use one of: ${Object.keys(COUNT_WORDS).join(", ")}`,
    ).toBe(true);

    expect(
      isCountWord(word) ? COUNT_WORDS[word] : Number.NaN,
      `${README_PATH} says "Exactly ${word} read tools" but LAW_MCP_TOOL_DISPOSITION marks ${lawSurfaceToolNames.length} tools as "corpus"; edit the /mcp-law bullet in ${README_PATH}`,
    ).toBe(lawSurfaceToolNames.length);
  });

  test("the listed tools are exactly the law-surface tools", () => {
    const listed = [...(claim?.["tools"] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      // A capture group is typed as possibly absent; the pattern cannot
      // match without it, so a missing one would be a broken pattern.
      ([, name]) => name ?? "",
    );

    expect(
      listed.toSorted(),
      `the /mcp-law tool list in ${README_PATH} disagrees with LAW_MCP_TOOL_DISPOSITION, whose "corpus" tools are: ${lawSurfaceToolNames.join(", ")}`,
    ).toEqual(lawSurfaceToolNames.toSorted());
  });
});

import { describe, expect, test } from "bun:test";

import {
  extractFrontmatterBlock,
  preservesFrontmatter,
} from "./frontmatter-guard";

const FRONTMATTER = `---
name: contract-review
description: Review a contract.
---`;

const ORIGINAL = `${FRONTMATTER}

# Contract review

Read the contract.`;

describe("extractFrontmatterBlock", () => {
  test("returns the block up to and including the closing delimiter", () => {
    expect(extractFrontmatterBlock(ORIGINAL)).toBe(FRONTMATTER);
  });

  test("normalizes CRLF documents to the LF block", () => {
    expect(extractFrontmatterBlock(ORIGINAL.replaceAll("\n", "\r\n"))).toBe(
      FRONTMATTER,
    );
  });

  test("returns undefined without an opening delimiter on the first line", () => {
    expect(extractFrontmatterBlock("# Contract review\n\n---\nx\n---")).toBe(
      undefined,
    );
    expect(extractFrontmatterBlock(`\n${ORIGINAL}`)).toBe(undefined);
  });

  test("returns undefined for an unterminated block", () => {
    expect(extractFrontmatterBlock("---\nname: x\n\n# Body")).toBe(undefined);
  });

  test("stops at the first closing delimiter, not a later one", () => {
    expect(extractFrontmatterBlock("---\nname: x\n---\n\n---\n")).toBe(
      "---\nname: x\n---",
    );
  });
});

describe("preservesFrontmatter", () => {
  test("accepts a revision that only changes the body", () => {
    expect(
      preservesFrontmatter({
        original: ORIGINAL,
        revised: `${FRONTMATTER}\n\n# Contract review\n\nRead the contract twice.`,
      }),
    ).toBe(true);
  });

  test("accepts a revision whose only difference is CRLF line endings", () => {
    expect(
      preservesFrontmatter({
        original: ORIGINAL,
        revised: ORIGINAL.replaceAll("\n", "\r\n"),
      }),
    ).toBe(true);
  });

  test("rejects a dropped block", () => {
    expect(
      preservesFrontmatter({
        original: ORIGINAL,
        revised: "# Contract review\n\nRead the contract.",
      }),
    ).toBe(false);
  });

  test("rejects an edited field", () => {
    expect(
      preservesFrontmatter({
        original: ORIGINAL,
        revised: ORIGINAL.replace("contract-review", "contract-reviewer"),
      }),
    ).toBe(false);
  });

  test("rejects an added field", () => {
    expect(
      preservesFrontmatter({
        original: ORIGINAL,
        revised: ORIGINAL.replace(
          "description: Review a contract.",
          "description: Review a contract.\nversion: 1.0.0",
        ),
      }),
    ).toBe(false);
  });

  test("imposes nothing when the original has no frontmatter", () => {
    expect(
      preservesFrontmatter({
        original: "# Contract review\n\nRead the contract.",
        revised: `${FRONTMATTER}\n\n# Contract review`,
      }),
    ).toBe(true);
  });
});

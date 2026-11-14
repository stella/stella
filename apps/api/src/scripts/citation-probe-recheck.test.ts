import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  MAX_RECHECK_TARGETS,
  newestTextKey,
  parseRecheckTargets,
} from "@/api/scripts/citation-probe-recheck";

const ID_A = "01938e23-0b5c-7c11-9f00-1a2b3c4d5e6f";
const ID_B = "019ae51b-7d10-7a2e-8b44-0f1e2d3c4b5a";

describe("parseRecheckTargets", () => {
  test("reads jurisdiction and full document id pairs in order", () => {
    const parsed = parseRecheckTargets(`CZE:${ID_A}, SVK:${ID_B}`);
    expect(Result.isOk(parsed) ? parsed.value : parsed.error).toEqual([
      { jurisdiction: "CZE", documentId: ID_A },
      { jurisdiction: "SVK", documentId: ID_B },
    ]);
  });

  test("reads a repeated entry once", () => {
    const parsed = parseRecheckTargets(`CZE:${ID_A},CZE:${ID_A}`);
    expect(Result.isOk(parsed) ? parsed.value : parsed.error).toEqual([
      { jurisdiction: "CZE", documentId: ID_A },
    ]);
  });

  for (const [name, value] of [
    ["a shortened id", "CZE:01938e23-"],
    ["a missing jurisdiction", ID_A],
    ["a lowercase jurisdiction", `cze:${ID_A}`],
    ["an uppercase id", `CZE:${ID_A.toUpperCase()}`],
    ["an empty list", " , "],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(Result.isError(parseRecheckTargets(value))).toBe(true);
    });
  }

  test("refuses more entries than one run reads", () => {
    const entries = Array.from(
      { length: MAX_RECHECK_TARGETS + 1 },
      (_, index) =>
        `POL:${ID_A.slice(0, -4)}${index.toString(16).padStart(4, "0")}`,
    );
    expect(Result.isError(parseRecheckTargets(entries.join(",")))).toBe(true);
    expect(
      Result.isOk(
        parseRecheckTargets(entries.slice(0, MAX_RECHECK_TARGETS).join(",")),
      ),
    ).toBe(true);
  });
});

describe("newestTextKey", () => {
  const prefix = `legal-corpus/documents/jurisdiction=CZE/${ID_A}`;

  test("picks the newest text object and ignores the others", () => {
    expect(
      newestTextKey([
        { key: `${prefix}/a/text.zst`, lastModified: "2026-10-01T00:00:00Z" },
        {
          key: `${prefix}/b/ast.json.zst`,
          lastModified: "2026-10-30T00:00:00Z",
        },
        { key: `${prefix}/c/text.zst`, lastModified: "2026-10-20T00:00:00Z" },
      ]),
    ).toBe(`${prefix}/c/text.zst`);
  });

  test("names no key for a listing without contents", () => {
    expect(newestTextKey(undefined)).toBe(undefined);
  });

  test("names no key for a document without text", () => {
    expect(newestTextKey([{ key: `${prefix}/b/ast.json.zst` }])).toBe(
      undefined,
    );
  });
});

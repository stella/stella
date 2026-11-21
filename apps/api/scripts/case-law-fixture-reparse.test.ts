/**
 * The fixture re-parse generator keeps parsed output current without ever
 * vouching for an analysis it cannot re-check.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  CASE_LAW_FIXTURES_DIR,
  readCaseLawFixtureFile,
} from "./lib/case-law-fixture-analyses";
import {
  type RawReparser,
  type ReparseFixtureRow,
  reparseFixtureRow,
  sameJson,
} from "./lib/case-law-fixture-reparse";

const neverCalled: RawReparser = async () => {
  throw new Error("rows without raw must not reach a parser");
};

const isRow = (value: unknown): value is ReparseFixtureRow =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "case_number") === "string";

/** A real analysed decision, so fingerprints run over a real prompt. */
const analysedRow = async (): Promise<ReparseFixtureRow> => {
  const fixture = await readCaseLawFixtureFile(
    path.join(CASE_LAW_FIXTURES_DIR, "cz-us.json.gz"),
  );
  const row = fixture.decisions.find(
    (decision) => decision.analysis !== null && decision.analysis !== undefined,
  );
  if (!isRow(row)) {
    throw new Error("cz-us.json.gz has no analysed decision");
  }
  return structuredClone(row);
};

const blocksOf = (ast: unknown): Record<string, unknown>[] => {
  const blocks: unknown =
    typeof ast === "object" && ast !== null
      ? Reflect.get(ast, "blocks")
      : undefined;
  if (!Array.isArray(blocks)) {
    throw new TypeError("Fixture AST has no blocks");
  }
  return blocks;
};

const firstParagraph = (blocks: Record<string, unknown>[]) => {
  const index = blocks.findIndex((block) => block["type"] === "paragraph");
  if (index === -1) {
    throw new Error("Fixture AST has no paragraph");
  }
  return index;
};

describe("committed fixtures", () => {
  test("are current, and none of them needs a parser to stay so", async () => {
    for (const name of [
      "cz-ns.json.gz",
      "cz-nss.json.gz",
      "cz-regional.json.gz",
      "cz-us.json.gz",
      "eu-ecj.json.gz",
      "pl-courts.json.gz",
      "sk-courts.json.gz",
      "sk-us.json.gz",
    ]) {
      const fixture = await readCaseLawFixtureFile(
        path.join(CASE_LAW_FIXTURES_DIR, name),
      );
      for (const decision of fixture.decisions) {
        if (!isRow(decision)) {
          throw new Error(`${name}: malformed row`);
        }
        const result = await reparseFixtureRow({
          adapterKey: "unused",
          row: decision,
          reparse: neverCalled,
        });
        expect(result, `${name} ${decision.case_number}`).toEqual({
          type: "unchanged",
        });
      }
    }
  });
});

describe("rows recorded with raw", () => {
  test("take the adapter's new parse and version", async () => {
    const row = await analysedRow();
    row.analysis = null;
    row.source_raw = "<recorded payload>";
    const documentAst = structuredClone(row.document_ast);
    const blocks = blocksOf(documentAst);
    const paragraph = firstParagraph(blocks);
    blocks[paragraph] = { ...blocks[paragraph], number: 1 };
    let input: unknown;
    const result = await reparseFixtureRow({
      adapterKey: "cz-us",
      row,
      reparse: async (adapterKey, stored) => {
        expect(adapterKey).toBe("cz-us");
        input = stored;
        return {
          documentAst,
          sections: row.sections ?? null,
          fulltext: row.fulltext ?? null,
          parserVersion: 99,
        };
      },
    });
    expect(input).toMatchObject({
      caseNumber: row.case_number,
      court: row.court,
      language: row.language,
    });
    expect(result.type).toBe("changed");
    if (result.type === "changed") {
      expect(result.via).toBe("reparsed");
      expect(result.row.parser_version).toBe(99);
      expect(
        blocksOf(result.row.document_ast)[firstParagraph(blocks)],
      ).toHaveProperty("number", 1);
    }
  });

  test("fail when the recorded raw no longer parses", async () => {
    const row = await analysedRow();
    row.source_raw = "<recorded payload>";
    const result = await reparseFixtureRow({
      adapterKey: "cz-us",
      row,
      reparse: async () => ({ rejected: "unsupported-content" }),
    });
    expect(result).toMatchObject({ type: "failed" });
  });
});

describe("stored analyses", () => {
  test("survive a re-parse that keeps the analysed text", async () => {
    const row = await analysedRow();
    row.source_raw = "<recorded payload>";
    const result = await reparseFixtureRow({
      adapterKey: "cz-us",
      row,
      reparse: async () => ({
        documentAst: row.document_ast,
        sections: row.sections ?? null,
        fulltext: row.fulltext ?? null,
        parserVersion: (row.parser_version ?? 0) + 1,
      }),
    });
    expect(result.type).toBe("changed");
    if (result.type === "changed") {
      // Never re-stamped: the analysis object is the one that was stored.
      expect(result.row.analysis).toEqual(row.analysis);
    }
  });

  test.each(["text", "court-number"] as const)(
    "fail the row when the new parse changes the analysed %s",
    async (change) => {
      const row = await analysedRow();
      row.source_raw = "<recorded payload>";
      const documentAst = structuredClone(row.document_ast);
      const blocks = blocksOf(documentAst);
      const index = blocks.findIndex(
        (block) =>
          block["type"] === "paragraph" &&
          typeof block["plainText"] === "string" &&
          block["plainText"] !== "",
      );
      const block = blocks[index];
      if (block === undefined) {
        throw new TypeError("Fixture AST has no nonempty paragraph");
      }
      switch (change) {
        case "text":
          blocks[index] = { ...block, plainText: "Reworded by a new parser" };
          break;
        case "court-number":
          blocks[index] = {
            ...block,
            number:
              typeof block["number"] === "number" ? block["number"] + 1 : 1,
          };
          break;
        default:
          change satisfies never;
      }
      expect(sameJson(documentAst, row.document_ast)).toBe(false);
      const result = await reparseFixtureRow({
        adapterKey: "cz-us",
        row,
        reparse: async () => ({
          documentAst,
          sections: row.sections ?? null,
          fulltext: row.fulltext ?? null,
          parserVersion: row.parser_version ?? null,
        }),
      });
      expect(result.type).toBe("failed");
      if (result.type === "failed") {
        expect(result.message).toContain("never re-stamped");
      }
    },
  );
});

test("comparison ignores key order only", () => {
  expect(
    sameJson(
      { a: 1, b: [1, { c: 2, d: 3 }] },
      { b: [1, { d: 3, c: 2 }], a: 1 },
    ),
  ).toBe(true);
  expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
});

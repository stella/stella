import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  classifiedCitationBlockIds,
  findCitationPassage,
} from "@stll/legal-ast/citation-passage";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { DECISION_ROW_AST_VERSION_CHANGED } from "@/api/lib/case-law/decision-row-ast-cache";
import { createDecisionSectionCache } from "@/api/lib/case-law/decision-section-cache";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import {
  currentReadWork,
  recordDbResult,
} from "@/api/lib/observability/request-work";

const astFor = (texts: string[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "decision", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: texts.map((text, index) => ({
    id: `p${index}`,
    anchorId: `p${index}`,
    type: "paragraph",
    plainText: text,
    inlines: [{ type: "text", text }],
  })),
});

test("section block references preserve every classified citation choice", async () => {
  await assertProperty(
    "section block references preserve every classified citation choice",
    fc.asyncProperty(
      fc.array(
        fc.constantFrom(
          "Rozsudek 12 Cdo 123/2026.",
          "Usnesení 12 Cdo 123/2026.",
          "قرار 12 Cdo 123/2026.",
          "Rozhodnutí bez odkazu.",
        ),
        { minLength: 1, maxLength: 12 },
      ),
      async (texts) => {
        const ast = astFor(texts);
        const sections = texts.map((text, index) => ({
          index,
          type: "argumentation" as const,
          title: null,
          text,
        }));
        const read = createDecisionSectionCache({ maxBytes: 1024 * 1024 });
        const index = await read({
          key: "version",
          ast,
          readSections: async () => sections,
        });
        expect(index?.length).toBe(sections.length);
        for (const section of sections) {
          const expected = findCitationPassage({
            blocks: ast.blocks,
            citationText: "12 Cdo 123/2026",
            classifiedBlockIds: ast.blocks
              .filter((block) => section.text.includes(block.plainText))
              .map((block) => block.id),
          });
          const actual = findCitationPassage({
            blocks: ast.blocks,
            citationText: "12 Cdo 123/2026",
            classifiedBlockIds: classifiedCitationBlockIds(
              ast,
              index?.find((item) => item.index === section.index)?.blockIndices,
            ),
          });
          expect(actual).toEqual(expected);
        }
      },
    ),
  );
});

test("section continuation pages transfer no document-sized DB text at either scale", async () => {
  for (const scale of [1, 10]) {
    const text = "Rozsudek 12 Cdo 123/2026. ".repeat(1000 * scale);
    const ast = astFor([text]);
    const read = createDecisionSectionCache({ maxBytes: 1024 * 1024 });
    const options = {
      key: "version",
      ast,
      readSections: async () => {
        const sections = [
          { index: 0, type: "argumentation" as const, title: null, text },
        ];
        recordDbResult(sections);
        return sections;
      },
    };
    const cold = await runWithQueryCounter(async () => {
      await read(options);
      return currentReadWork();
    });
    const warm = await runWithQueryCounter(async () => {
      await read(options);
      return currentReadWork();
    });
    expect(cold?.dbResultBytes).toBeGreaterThan(text.length);
    expect(warm?.dbResultBytes).toBe(0);
    expect(warm?.cacheHits).toBe(1);
    // Updating a projection must load its current segmentation.
    const changed = await runWithQueryCounter(async () => {
      await read({ ...options, key: "next-version" });
      return currentReadWork();
    });
    expect(changed?.dbResultBytes).toBe(cold?.dbResultBytes);
  }
});

test("section references reject an index outside the supplying AST", () => {
  const ast = astFor(["12 Cdo 123/2026"]);
  expect(() => classifiedCitationBlockIds(ast, [-1])).toThrow(
    "invalid document block index",
  );
  expect(() => classifiedCitationBlockIds(ast, [1])).toThrow(
    "missing document block",
  );
});

test("changed section versions are retried without caching an empty index", async () => {
  const read = createDecisionSectionCache({ maxBytes: 1024 * 1024 });
  const ast = astFor(["Reasoning"]);
  let changed = 0;
  expect(
    await read({
      key: "version",
      ast,
      readSections: async () => DECISION_ROW_AST_VERSION_CHANGED,
      onVersionChanged: () => {
        changed += 1;
      },
    }),
  ).toBeNull();
  expect(changed).toBe(1);
  const sections = await read({
    key: "version",
    ast,
    readSections: async () => [
      { index: 0, type: "argumentation", title: null, text: "Reasoning" },
    ],
  });
  expect(sections?.at(0)?.blockIndices).toEqual([0]);
});

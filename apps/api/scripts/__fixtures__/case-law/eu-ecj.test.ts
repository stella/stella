/**
 * Guard on the recorded eu-ecj seed fixture.
 *
 * ECJ decisions used to be stored with `document_ast: {}` and a single
 * catch-all section, which the reader renders as an unstructured wall
 * of text. The fixture is what a developer sees after
 * `bun run db:seed-case-law`, so it is also the cheapest place to make
 * that state fail rather than pass quietly.
 *
 * Regenerate with `bun apps/api/scripts/record-eu-ecj-fixtures.ts`;
 * the fixture is adapter output and must never be hand-edited.
 */

import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import type { DecisionSection } from "@/api/handlers/case-law/types";

type FixtureDecision = {
  case_number: string;
  language: string;
  decision_type: string | null;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  document_ast: unknown;
  metadata: Record<string, unknown> | null;
};

const fixture: { decisions: FixtureDecision[] } = await Bun.file(
  new URL("eu-ecj.json", import.meta.url),
).json();

describe("eu-ecj seed fixture", () => {
  test("is not empty", () => {
    expect(fixture.decisions.length).toBeGreaterThan(0);
  });

  describe.each(
    fixture.decisions.map(
      (decision) =>
        [`${decision.case_number} ${decision.language}`, decision] as const,
    ),
  )("%s", (_label, decision) => {
    test("carries a parsed AST and navigable sections", () => {
      expect(hasUsableAst(decision.document_ast)).toBe(true);
      expect(decision.sections?.length ?? 0).toBeGreaterThan(1);
      expect(decision.fulltext?.length ?? 0).toBeGreaterThan(1000);
    });

    test("keeps the metadata the SPARQL query already resolved", () => {
      expect(decision.metadata).toMatchObject({
        celex: expect.any(String),
        keywords: expect.any(Array),
      });
    });
  });

  test("covers more than one language", () => {
    expect(
      new Set(fixture.decisions.map((decision) => decision.language)).size,
    ).toBeGreaterThan(1);
  });
});

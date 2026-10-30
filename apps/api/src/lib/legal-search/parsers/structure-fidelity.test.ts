import { expect, test } from "bun:test";

import type { ParagraphBlock } from "@stll/legal-ast/document-ast";

import { structureFidelityIn } from "./structure-fidelity";

const paragraph = (anchorId: string, plainText: string): ParagraphBlock => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  role: "intro",
  inlines: [{ type: "text", text: plainText }],
  plainText,
});

test("a sentence split between paragraph blocks is reported at its first half", () => {
  const findings = structureFidelityIn([
    paragraph(
      "p-1",
      "Sąd Apelacyjny w Szczecinie rozpoznał sprawę na posiedzeniu niejawnym,",
    ),
    paragraph("p-2", "sprawy z odwołania strony."),
  ]);

  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    rule: "sentence-cut",
    anchorId: "p-1",
  });
  expect(findings[0]?.excerpt).toContain("⏎ sprawy z odwołania strony.");
});

test("a sentence kept in one paragraph has no sentence-cut finding", () => {
  const findings = structureFidelityIn([
    paragraph(
      "p-1",
      "Sąd rozpoznał sprawę na posiedzeniu niejawnym, sprawy z odwołania strony.",
    ),
  ]);

  expect(findings).toEqual([]);
});

import { expect, test } from "bun:test";
import * as v from "valibot";

import { documentAstSchema } from "@stll/legal-ast/document-ast";

import { parseSkUsDocumentXhtml } from "./sk-us";

test("empty title runs preserve blank boundaries without styling the following body", () => {
  // Exhaust the finite layout class: every title/body font boundary, trailing
  // line-break count and empty run must retain the body with unique identities.
  for (const titleLines of [
    ["NÁLEZ"],
    ["NÁLEZ", "Ústavného súdu Slovenskej republiky"],
    [
      "NÁLEZ",
      "Ústavného súdu Slovenskej republiky",
      "V mene Slovenskej republiky",
    ],
  ]) {
    for (const titleFont of [18, 21, 24]) {
      for (const bodyFont of [10, 12, 14]) {
        for (const breakCount of [1, 2, 3, 4]) {
          for (const empty of [
            "",
            " ",
            "&nbsp;",
            '<span style="font-size: 28px"> </span>',
          ]) {
            const body = "Ústavný súd posúdil ústavnú sťažnosť sťažovateľa.";
            const parsed = parseSkUsDocumentXhtml({
              xhtml: `<html><body><div><span style="font-size: ${titleFont}px">${titleLines.join("<br/><br/>")}${"<br/>".repeat(breakCount)}</span>${empty}<span style="font-size: ${bodyFont}px">${body}<br/><br/>rozhodol:<br/><br/>Sťažnosť zamieta.</span></div></body></html>`,
              caseNumber: "III. ÚS 1/2026",
              ecli: undefined,
              court: "Ústavný súd SR",
              decisionDate: undefined,
              decisionType: "Nález",
              documentUrl: "https://example.test/decision",
            });
            expect(
              v.safeParse(documentAstSchema, parsed.documentAst).success,
            ).toBe(true);
            const identities = parsed.documentAst.blocks.flatMap(
              ({ id, anchorId }) => [id, anchorId],
            );
            expect(new Set(identities).size).toBe(identities.length);
            expect(
              parsed.documentAst.blocks.filter(
                (block) => block.anchorId === "h-title",
              ),
            ).toHaveLength(1);
            expect(
              parsed.documentAst.blocks.some(
                (block) =>
                  block.type === "paragraph" && block.plainText.includes(body),
              ),
            ).toBe(true);
            expect(parsed.fulltext).toContain(body);
            // Multiple breaks must still separate the title from its body.
            expect(parsed.fulltext).toContain(
              `${titleLines.join("\n\n")}\n\n${body}`,
            );
          }
        }
      }
    }
  }
});

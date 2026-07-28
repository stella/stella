import { describe, expect, test } from "bun:test";

import { iterateJustificationCitations } from "@/lib/citations";
import type { JustificationContent } from "@/lib/types";

describe("iterateJustificationCitations — docx-folio status threading", () => {
  test("a verified citation yields a navigable blockId", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "docx-folio",
          fileFieldId: "field-1",
          statements: [
            {
              text: "The buyer indemnifies the seller.",
              citations: [
                {
                  citationStatus: "verified",
                  blockId: "AAAA0001",
                  text: "The buyer indemnifies the seller.",
                },
              ],
            },
          ],
        },
      ],
    };

    const citations = [...iterateJustificationCitations(content)];
    expect(citations).toEqual([
      {
        kind: "docx-folio",
        citationStatus: "verified",
        fileFieldId: "field-1",
        blockId: "AAAA0001",
        text: "The buyer indemnifies the seller.",
      },
    ]);
  });

  test("an unverified citation yields no navigable target", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "docx-folio",
          fileFieldId: "field-1",
          statements: [
            {
              text: "claim",
              citations: [
                {
                  citationStatus: "unverified",
                  text: "The tenant waived all remedies.",
                },
              ],
            },
          ],
        },
      ],
    };

    const citation = [...iterateJustificationCitations(content)].at(0);
    expect(citation?.kind).toBe("docx-folio");
    if (citation?.kind !== "docx-folio") {
      throw new Error("expected a docx-folio citation");
    }
    expect(citation.citationStatus).toBe("unverified");
    // The union has no `blockId` on the unverified branch — the click
    // handlers key navigation off its presence, so an unverified citation
    // is non-navigable by construction.
    expect("blockId" in citation).toBe(false);
  });
});

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

  test("yields every citation from a pdf-bates block", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "pdf-bates",
          fileFieldId: "field-pdf",
          statements: [
            {
              text: "first claim",
              citations: [{ bates: "ABC0001", pageNumber: 2 }],
            },
            {
              text: "second claim",
              citations: [{ bates: "ABC0002", pageNumber: 7 }],
            },
          ],
        },
      ],
    };

    expect([...iterateJustificationCitations(content)]).toEqual([
      {
        kind: "pdf-bates",
        fileFieldId: "field-pdf",
        bates: "ABC0001",
        pageNumber: 2,
      },
      {
        kind: "pdf-bates",
        fileFieldId: "field-pdf",
        bates: "ABC0002",
        pageNumber: 7,
      },
    ]);
  });

  test("skips playbook-verdict blocks", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "playbook-verdict",
          rationale: "The clause meets the requirement.",
        },
      ],
    };

    expect([...iterateJustificationCitations(content)]).toEqual([]);
  });

  test("preserves citation order across mixed block kinds", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "pdf-bates",
          fileFieldId: "field-pdf",
          statements: [{ text: "claim", citations: [{ bates: "ABC0001", pageNumber: 1 }] }],
        },
        {
          kind: "playbook-verdict",
          rationale: "No document citation.",
        },
        {
          kind: "docx-folio",
          fileFieldId: "field-docx",
          statements: [
            {
              text: "claim",
              citations: [
                { citationStatus: "verified", blockId: "BBBB0001", text: "quoted text" },
              ],
            },
          ],
        },
      ],
    };

    expect([...iterateJustificationCitations(content)]).toEqual([
      { kind: "pdf-bates", fileFieldId: "field-pdf", bates: "ABC0001", pageNumber: 1 },
      {
        kind: "docx-folio",
        citationStatus: "verified",
        fileFieldId: "field-docx",
        blockId: "BBBB0001",
        text: "quoted text",
      },
    ]);
  });

  test("yields no citations for empty content", () => {
    expect([...iterateJustificationCitations({ version: 1, blocks: [] })]).toEqual([]);
  });
});

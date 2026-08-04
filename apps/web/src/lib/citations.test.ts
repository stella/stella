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

describe("iterateJustificationCitations — pdf-bates block", () => {
  test("yields one citation per bates reference", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "pdf-bates",
          fileFieldId: "pdf-field-1",
          statements: [
            {
              text: "Clause 4.1 applies.",
              citations: [
                { bates: "ACME-0001", pageNumber: 1 },
                { bates: "ACME-0002", pageNumber: 2 },
              ],
            },
          ],
        },
      ],
    };

    const citations = [...iterateJustificationCitations(content)];
    expect(citations).toEqual([
      {
        kind: "pdf-bates",
        fileFieldId: "pdf-field-1",
        bates: "ACME-0001",
        pageNumber: 1,
      },
      {
        kind: "pdf-bates",
        fileFieldId: "pdf-field-1",
        bates: "ACME-0002",
        pageNumber: 2,
      },
    ]);
  });
});

describe("iterateJustificationCitations — mixed blocks", () => {
  test("yields citations from all document blocks and skips playbook-verdict", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        {
          kind: "pdf-bates",
          fileFieldId: "pdf-field-1",
          statements: [
            { text: "first", citations: [{ bates: "REF-001", pageNumber: 5 }] },
          ],
        },
        {
          // playbook-verdict carries no document citations — should be skipped
          kind: "playbook-verdict",
          rationale: "Meets tier 2",
        },
        {
          kind: "docx-folio",
          fileFieldId: "docx-field-1",
          statements: [
            {
              text: "second",
              citations: [
                {
                  citationStatus: "verified",
                  blockId: "BLK-42",
                  text: "second",
                },
              ],
            },
          ],
        },
      ],
    };

    const citations = [...iterateJustificationCitations(content)];
    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({ kind: "pdf-bates", bates: "REF-001" });
    expect(citations[1]).toMatchObject({
      kind: "docx-folio",
      blockId: "BLK-42",
    });
  });
});

describe("iterateJustificationCitations — empty input", () => {
  test("yields nothing for an empty blocks array", () => {
    const content: JustificationContent = { version: 1, blocks: [] };
    expect([...iterateJustificationCitations(content)]).toEqual([]);
  });

  test("yields nothing for blocks with no statements", () => {
    const content: JustificationContent = {
      version: 1,
      blocks: [
        { kind: "pdf-bates", fileFieldId: "f", statements: [] },
        { kind: "docx-folio", fileFieldId: "f", statements: [] },
      ],
    };
    expect([...iterateJustificationCitations(content)]).toEqual([]);
  });
});

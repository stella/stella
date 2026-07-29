import { describe, expect, test } from "bun:test";

import type { JustificationBlock } from "@/api/db/schema";
import {
  buildCitationSection,
  isUnverifiedDocxCitation,
  resolveExportCitations,
  sourceDocumentsToCitations,
} from "@/api/handlers/chat/export/citation-footnotes";
import type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";

const fieldId = (id: string): SafeId<"field"> => toSafeId<"field">(id);

describe("isUnverifiedDocxCitation — missing status treated as verified", () => {
  test("explicit unverified is demoted", () => {
    expect(isUnverifiedDocxCitation({ citationStatus: "unverified" })).toBe(
      true,
    );
  });

  test("explicit verified is a source", () => {
    expect(isUnverifiedDocxCitation({ citationStatus: "verified" })).toBe(
      false,
    );
  });

  test("missing/legacy status is treated as verified", () => {
    expect(isUnverifiedDocxCitation({})).toBe(false);
  });
});

describe("resolveExportCitations — union switch per citation kind", () => {
  test("docx-folio verified citation yields its quoted source", () => {
    const block: JustificationBlock = {
      kind: "docx-folio",
      fileFieldId: fieldId("f1"),
      statements: [
        {
          text: "The buyer indemnifies the seller.",
          citations: [
            {
              citationStatus: "verified",
              blockId: "seq-1",
              text: "Buyer shall indemnify Seller.",
            },
          ],
        },
      ],
    };
    expect(resolveExportCitations([block])).toEqual([
      { status: "verified", source: "Buyer shall indemnify Seller." },
    ]);
  });

  test("docx-folio unverified citation yields a marker with no source", () => {
    const block: JustificationBlock = {
      kind: "docx-folio",
      fileFieldId: fieldId("f1"),
      statements: [
        {
          text: "Termination requires 90 days notice.",
          citations: [
            { citationStatus: "unverified", text: "ungrounded paraphrase" },
          ],
        },
      ],
    };
    expect(resolveExportCitations([block])).toEqual([{ status: "unverified" }]);
  });

  test("pdf-bates citation is grounded and formats a Bates locator", () => {
    const block: JustificationBlock = {
      kind: "pdf-bates",
      fileFieldId: fieldId("file-1"),
      statements: [
        {
          text: "Notice was served.",
          citations: [{ bates: "ACME-000123", pageNumber: 4 }],
        },
      ],
    };
    expect(
      resolveExportCitations([block], new Map([["file-1", "Notice.pdf"]])),
    ).toEqual([
      { status: "verified", source: "Notice.pdf, ACME-000123 (p. 4)" },
    ]);
  });

  test("pdf-bates without a resolved file name omits the file prefix", () => {
    const block: JustificationBlock = {
      kind: "pdf-bates",
      fileFieldId: fieldId("file-1"),
      statements: [
        {
          text: "Notice was served.",
          citations: [{ bates: "ACME-000123", pageNumber: 4 }],
        },
      ],
    };
    expect(resolveExportCitations([block])).toEqual([
      { status: "verified", source: "ACME-000123 (p. 4)" },
    ]);
  });

  test("playbook-verdict blocks contribute no source citations", () => {
    const block: JustificationBlock = {
      kind: "playbook-verdict",
      rationale: "Deviates from the fallback.",
    };
    expect(resolveExportCitations([block])).toEqual([]);
  });

  test("mixed blocks preserve order and both statuses", () => {
    const blocks: JustificationBlock[] = [
      {
        kind: "docx-folio",
        fileFieldId: fieldId("f1"),
        statements: [
          {
            text: "A",
            citations: [
              { citationStatus: "verified", blockId: "seq-1", text: "quote A" },
              { citationStatus: "unverified", text: "hint" },
            ],
          },
        ],
      },
    ];
    expect(resolveExportCitations(blocks)).toEqual([
      { status: "verified", source: "quote A" },
      { status: "unverified" },
    ]);
  });
});

describe("sourceDocumentsToCitations", () => {
  const doc = (title: string): ChatSourceDocument => ({
    entityId: "e1",
    kind: "document",
    mimeType: null,
    title,
    workspaceId: "w1",
  });

  test("each referenced document becomes a verified source titled by name", () => {
    expect(
      sourceDocumentsToCitations([doc("Share Purchase Agreement")], 50),
    ).toEqual([{ status: "verified", source: "Share Purchase Agreement" }]);
  });

  test("blank titles are skipped", () => {
    expect(sourceDocumentsToCitations([doc("   ")], 50)).toEqual([]);
  });

  test("document titles cannot inject Markdown into the source section", () => {
    expect(
      sourceDocumentsToCitations(
        [doc("  Agreement\n## Forged\n*emphasis* [link] <tag> C:\\temp  ")],
        50,
      ),
    ).toEqual([
      {
        status: "verified",
        source:
          "Agreement ## Forged \\*emphasis\\* \\[link\\] \\<tag\\> C:\\\\temp",
      },
    ]);
  });

  test("undefined source documents yield no citations", () => {
    expect(sourceDocumentsToCitations(undefined, 50)).toEqual([]);
  });

  test("the limit caps how many documents are cited", () => {
    expect(
      sourceDocumentsToCitations([doc("A"), doc("B"), doc("C")], 2),
    ).toEqual([
      { status: "verified", source: "A" },
      { status: "verified", source: "B" },
    ]);
  });
});

describe("buildCitationSection", () => {
  const verified = (source: string) =>
    ({ status: "verified", source }) as const;
  const unverified = () => ({ status: "unverified" }) as const;

  test("none style renders nothing", () => {
    const section = buildCitationSection(
      [verified("Source A"), unverified()],
      "none",
    );
    expect(section).toEqual({
      markdown: "",
      verifiedCount: 0,
      unverifiedCount: 0,
    });
  });

  test("footnotes style numbers verified sources under a heading", () => {
    const section = buildCitationSection(
      [verified("Source A"), verified("Source B")],
      "footnotes",
    );
    expect(section.markdown).toBe("## Sources\n\n1. Source A\n2. Source B");
    expect(section.verifiedCount).toBe(2);
    expect(section.unverifiedCount).toBe(0);
  });

  test("footnotes style summarises unverified citations without a source", () => {
    const section = buildCitationSection(
      [verified("Source A"), unverified(), unverified()],
      "footnotes",
    );
    expect(section.markdown).toBe(
      "## Sources\n\n1. Source A\n\n*2 citations could not be verified against a source and are omitted.*",
    );
    expect(section.unverifiedCount).toBe(2);
    // The ungrounded citations never appear as a source line.
    expect(section.markdown).not.toContain("2. ");
  });

  test("duplicate verified sources collapse to one line", () => {
    const section = buildCitationSection(
      [verified("Source A"), verified("Source A")],
      "footnotes",
    );
    expect(section.markdown).toBe("## Sources\n\n1. Source A");
    expect(section.verifiedCount).toBe(1);
  });

  test("inline style joins verified sources into one paragraph", () => {
    const section = buildCitationSection(
      [verified("Source A"), verified("Source B")],
      "inline",
    );
    expect(section.markdown).toBe("**Sources:** Source A; Source B");
  });

  test("an all-unverified footnotes export renders only the omission note", () => {
    const section = buildCitationSection([unverified()], "footnotes");
    expect(section.markdown).toBe(
      "*1 citation could not be verified against a source and is omitted.*",
    );
    expect(section.verifiedCount).toBe(0);
    expect(section.unverifiedCount).toBe(1);
  });
});

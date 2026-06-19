import { describe, expect, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";

const field = (id: string): SafeId<"field"> => toSafeId<"field">(id);

const unwrap = (result: ReturnType<typeof normalizeJustification>) =>
  result.unwrap();

describe("normalizeJustification — file matching", () => {
  test("drops AI blocks whose file is not in the allow-list", () => {
    const filenames: JustificationFilenames = [
      {
        kind: "pdf-bates",
        original: "Contract.pdf",
        simplified: "contract",
        fileFieldId: field("f1"),
      },
    ];
    const justification: AIJustificationOutput = [
      {
        file: "hallucinated-file",
        statements: [{ text: "claim", citations: ["contract-1"] }],
      },
    ];

    expect(unwrap(normalizeJustification({ justification, filenames }))).toBe(
      null,
    );
  });
});

describe("normalizeJustification — pdf-bates branch", () => {
  const filenames: JustificationFilenames = [
    {
      kind: "pdf-bates",
      original: "Contract.pdf",
      simplified: "contract",
      fileFieldId: field("f-pdf"),
    },
  ];

  test("keeps only citations that match the `<file>-<page>` bates prefix", () => {
    const justification: AIJustificationOutput = [
      {
        file: "contract",
        statements: [
          {
            text: "  Payment is due in 30 days.  ",
            citations: [
              "contract-3", // valid
              "other-3", // wrong file prefix
              "contract-0", // page < 1
              "contract-x", // non-integer page
            ],
          },
        ],
      },
    ];

    expect(
      unwrap(normalizeJustification({ justification, filenames })),
    ).toEqual({
      content: {
        version: 1,
        blocks: [
          {
            kind: "pdf-bates",
            fileFieldId: field("f-pdf"),
            statements: [
              {
                // text is trimmed
                text: "Payment is due in 30 days.",
                citations: [{ bates: "contract-3", pageNumber: 3 }],
              },
            ],
          },
        ],
      },
      fileFieldIds: [field("f-pdf")],
    });
  });

  test("drops statements with empty text or no valid citations", () => {
    const justification: AIJustificationOutput = [
      {
        file: "contract",
        statements: [
          { text: "   ", citations: ["contract-1"] }, // blank text
          { text: "real claim", citations: ["bogus-9"] }, // no valid cite
        ],
      },
    ];

    expect(unwrap(normalizeJustification({ justification, filenames }))).toBe(
      null,
    );
  });
});

describe("normalizeJustification — docx-folio branch", () => {
  const filenames: JustificationFilenames = [
    {
      kind: "docx-folio",
      original: "Brief.docx",
      simplified: "brief",
      fileFieldId: field("f-docx"),
      blocksById: new Map([
        ["AAAA0001", "First paragraph text."],
        ["seq-0002", "Second paragraph text."],
      ]),
    },
  ];

  test("allow-lists known block ids, embeds their literal text, and dedupes", () => {
    const justification: AIJustificationOutput = [
      {
        file: "brief",
        statements: [
          {
            text: " The defendant breached. ",
            citations: [
              "AAAA0001", // known paraId-shaped id
              "AAAA0001", // duplicate -> dropped
              "seq-0002", // known sequential id
              "seq-9999", // structurally valid but not in blocksById -> dropped
              "seq-", // malformed sequential -> dropped by isFolioBlockId
              "  ", // empty after trim -> dropped
            ],
          },
        ],
      },
    ];

    expect(
      unwrap(normalizeJustification({ justification, filenames })),
    ).toEqual({
      content: {
        version: 1,
        blocks: [
          {
            kind: "docx-folio",
            fileFieldId: field("f-docx"),
            statements: [
              {
                text: "The defendant breached.",
                citations: [
                  { blockId: "AAAA0001", text: "First paragraph text." },
                  { blockId: "seq-0002", text: "Second paragraph text." },
                ],
              },
            ],
          },
        ],
      },
      fileFieldIds: [field("f-docx")],
    });
  });

  test("trims citation ids before matching the allow-list", () => {
    const justification: AIJustificationOutput = [
      {
        file: "brief",
        statements: [{ text: "claim", citations: ["  AAAA0001  "] }],
      },
    ];

    const result = unwrap(normalizeJustification({ justification, filenames }));

    expect(result).toEqual({
      content: {
        version: 1,
        blocks: [
          {
            kind: "docx-folio",
            fileFieldId: field("f-docx"),
            statements: [
              {
                text: "claim",
                citations: [
                  { blockId: "AAAA0001", text: "First paragraph text." },
                ],
              },
            ],
          },
        ],
      },
      fileFieldIds: [field("f-docx")],
    });
  });

  test("returns null when every citation is rejected by the allow-list", () => {
    const justification: AIJustificationOutput = [
      {
        file: "brief",
        statements: [{ text: "claim", citations: ["seq-9999", "BBBB9999"] }],
      },
    ];

    // "BBBB9999" passes isFolioBlockId structurally but is absent from
    // blocksById, and "seq-9999" is absent too — both dropped.
    expect(unwrap(normalizeJustification({ justification, filenames }))).toBe(
      null,
    );
  });
});

describe("normalizeJustification — multi-file aggregation", () => {
  test("collects distinct fileFieldIds across surviving blocks only", () => {
    const filenames: JustificationFilenames = [
      {
        kind: "pdf-bates",
        original: "A.pdf",
        simplified: "a",
        fileFieldId: field("fa"),
      },
      {
        kind: "docx-folio",
        original: "B.docx",
        simplified: "b",
        fileFieldId: field("fb"),
        blocksById: new Map([["AAAA0001", "B text."]]),
      },
      {
        kind: "pdf-bates",
        original: "C.pdf",
        simplified: "c",
        fileFieldId: field("fc"),
      },
    ];
    const justification: AIJustificationOutput = [
      { file: "a", statements: [{ text: "x", citations: ["a-1"] }] },
      { file: "b", statements: [{ text: "y", citations: ["AAAA0001"] }] },
      // file "c" present but all citations invalid -> block dropped, fc excluded
      { file: "c", statements: [{ text: "z", citations: ["nope-1"] }] },
    ];

    const result = unwrap(normalizeJustification({ justification, filenames }));

    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected a normalized justification");
    }
    expect(result.fileFieldIds).toEqual([field("fa"), field("fb")]);
    expect(result.content.blocks.map((b) => b.kind)).toEqual([
      "pdf-bates",
      "docx-folio",
    ]);
  });
});

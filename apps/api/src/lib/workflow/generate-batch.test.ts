import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { JustificationContent } from "@/api/db/schema";
import { extractJustificationContent } from "@/api/lib/bbox/generate-b-boxes-shared";
import { toSafeId } from "@/api/lib/branded-types";
import { createMockJustifications } from "@/api/lib/workflow/generate-batch-mock";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";

const fieldId = (value: string) => toSafeId<"field">(value);

describe("justifications", () => {
  const filenames: JustificationFilenames = [
    {
      kind: "pdf-bates",
      original: "filename-a",
      simplified: "F0",
      fileFieldId: fieldId("file-field-0"),
    },
    {
      kind: "pdf-bates",
      original: "filename-b",
      simplified: "F1",
      fileFieldId: fieldId("file-field-1"),
    },
  ];

  test("normalizes structured AI justifications", () => {
    const justification: AIJustificationOutput = [
      {
        file: "F0",
        statements: [
          {
            text: " Party A signed the agreement. ",
            citations: ["F0-0001", "F0-0002"],
          },
        ],
      },
      {
        file: "F1",
        statements: [
          {
            text: "Party B accepted the terms.",
            citations: ["F1-0003"],
          },
        ],
      },
    ];

    const result = normalizeJustification({
      filenames,
      justification,
    }).unwrap();

    expect(result).toEqual({
      content: {
        version: 1,
        blocks: [
          {
            kind: "pdf-bates",
            fileFieldId: fieldId("file-field-0"),
            statements: [
              {
                text: "Party A signed the agreement.",
                citations: [
                  { bates: "F0-0001", pageNumber: 1 },
                  { bates: "F0-0002", pageNumber: 2 },
                ],
              },
            ],
          },
          {
            kind: "pdf-bates",
            fileFieldId: fieldId("file-field-1"),
            statements: [
              {
                text: "Party B accepted the terms.",
                citations: [{ bates: "F1-0003", pageNumber: 3 }],
              },
            ],
          },
        ],
      },
      fileFieldIds: [fieldId("file-field-0"), fieldId("file-field-1")],
    });
  });

  test("drops unknown files and malformed citations", () => {
    const justification: AIJustificationOutput = [
      {
        file: "unknown",
        statements: [{ text: "Ignored", citations: ["unknown-0001"] }],
      },
      {
        file: "F0",
        statements: [
          { text: "No valid citation", citations: ["F1-0001", "F0-zero"] },
          { text: "Valid citation", citations: [" F0-0010 "] },
        ],
      },
    ];

    const result = normalizeJustification({
      filenames,
      justification,
    }).unwrap();

    expect(result?.content.blocks).toEqual([
      {
        kind: "pdf-bates",
        fileFieldId: fieldId("file-field-0"),
        statements: [
          {
            text: "Valid citation",
            citations: [{ bates: "F0-0010", pageNumber: 10 }],
          },
        ],
      },
    ]);
    expect(result?.fileFieldIds).toEqual([fieldId("file-field-0")]);
  });

  test("returns null when no usable justification remains", () => {
    const result = normalizeJustification({
      filenames,
      justification: [
        {
          file: "F0",
          statements: [{ text: "Unsupported", citations: ["F0-0000"] }],
        },
      ],
    }).unwrap();

    expect(result).toBeNull();
  });

  test("extracts bbox prompt text and unique pages", () => {
    const normalized = normalizeJustification({
      filenames,
      justification: [
        {
          file: "F0",
          statements: [
            { text: "First fact.", citations: ["F0-0001", "F0-0002"] },
            { text: "Second fact.", citations: ["F0-0002"] },
          ],
        },
      ],
    }).unwrap();

    expect(normalized).not.toBeNull();

    if (!normalized) {
      return;
    }

    const result = extractJustificationContent(normalized.content).unwrap();

    expect(result).toEqual({
      justificationText: "First fact. Second fact.",
      pageNumbers: [1, 2],
    });
  });

  test("fails bbox extraction for empty text", () => {
    const result = extractJustificationContent({
      version: 1,
      blocks: [],
    });

    expect(Result.isError(result)).toBe(true);
  });

  // Regression: rows persisted before the `kind` discriminator on
  // `JustificationBlock` was added (PR #56) have the legacy shape
  // `{ fileFieldId, statements }`. The bbox extractor must still treat
  // those as PDF citations and surface their text + page numbers.
  test("extractJustificationContent treats pre-kind blocks as pdf-bates", () => {
    // The whole point of this test is the runtime tolerance for
    // blocks missing the `kind` field. The typed source can't
    // express that shape, so we widen via `unknown` once at the
    // call boundary instead of producing a partial union member.
    const legacyContent = {
      version: 1 as const,
      blocks: [
        {
          fileFieldId: fieldId("legacy-field"),
          statements: [
            {
              text: "Legacy fact.",
              citations: [{ bates: "L00001", pageNumber: 7 }],
            },
          ],
        },
      ],
    } satisfies { version: 1; blocks: unknown[] };

    // SAFETY: the test deliberately constructs a value that the
    // current typed surface can't express (pre-`kind` legacy shape).
    // The runtime tolerance for that shape is the system under test.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const legacy = legacyContent as unknown as JustificationContent;
    const result = extractJustificationContent(legacy).unwrap();

    expect(result.justificationText).toBe("Legacy fact.");
    expect(result.pageNumbers).toEqual([7]);
  });

  test("extractJustificationContent skips docx-folio blocks", () => {
    const result = extractJustificationContent({
      version: 1,
      blocks: [
        {
          kind: "pdf-bates",
          fileFieldId: fieldId("pdf-field"),
          statements: [
            {
              text: "Pdf fact.",
              citations: [{ bates: "P00001", pageNumber: 3 }],
            },
          ],
        },
        {
          kind: "docx-folio",
          fileFieldId: fieldId("docx-field"),
          statements: [
            {
              text: "Docx fact.",
              citations: [{ blockId: "b-0042", text: "quoted" }],
            },
          ],
        },
      ],
    }).unwrap();

    // The docx block contributes neither text nor a "page number" —
    // it has no pageNumber field at all.
    expect(result.justificationText).toBe("Pdf fact.");
    expect(result.pageNumbers).toEqual([3]);
  });

  test("createMockJustifications produces valid structured justifications", () => {
    const justification = createMockJustifications(filenames);
    const result = normalizeJustification({
      filenames,
      justification,
    }).unwrap();

    expect(result).not.toBeNull();

    if (!result) {
      return;
    }

    expect(result.fileFieldIds).toEqual([
      fieldId("file-field-0"),
      fieldId("file-field-1"),
    ]);
    expect(
      extractJustificationContent(result.content).unwrap().pageNumbers,
    ).toEqual([1, 2]);
  });
});

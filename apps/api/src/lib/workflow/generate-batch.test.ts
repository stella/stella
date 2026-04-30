import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

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
      original: "filename-a",
      simplified: "F0",
      fileFieldId: fieldId("file-field-0"),
    },
    {
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

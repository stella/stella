import { describe, expect, test } from "bun:test";

import {
  decodeDocxExtraction,
  decodeDocxRestorationPlan,
  type NativeDocxRestorationPlan,
} from "../native-codec";
import type { DocxExtraction } from "../types";

const extraction = {
  contractVersion: 1,
  blocks: [
    {
      text: "Alice",
      location: {
        type: "paragraph",
        part: { type: "main-document", path: "word/document.xml" },
        blockIndex: 0,
        xmlPath: [0, 0, 0],
      },
      segments: [
        {
          start: 0,
          end: 5,
          source: "text",
          contexts: [],
          xmlPath: [0, 0, 0, 0, 0],
        },
      ],
    },
  ],
  coverage: {
    parts: [
      {
        status: "extracted",
        part: { type: "main-document", path: "word/document.xml" },
        blockCount: 1,
      },
    ],
    hyperlinkTextSegmentCount: 0,
    revisionTextSegmentCount: 0,
    unsupportedAlternateContentCount: 0,
    unsupportedSymbolCount: 0,
    unsupportedFieldInstructionCount: 0,
  },
} as const satisfies DocxExtraction;

const restorationPlan = {
  extraction,
  blocks: [
    {
      location: extraction.blocks[0].location,
      expectedText: "Alice",
      candidates: [{ start: 0, end: 5, candidate: "Alice" }],
    },
  ],
  candidateCount: 1,
} as const satisfies NativeDocxRestorationPlan;

describe("native DOCX codecs", () => {
  test("accept their complete versioned contracts", () => {
    expect(decodeDocxExtraction(JSON.stringify(extraction))).toEqual(
      extraction,
    );
    expect(decodeDocxRestorationPlan(JSON.stringify(restorationPlan))).toEqual(
      restorationPlan,
    );
  });

  test("reject unknown, missing, and structurally invalid fields", () => {
    expect(() =>
      decodeDocxExtraction(JSON.stringify({ ...extraction, extra: true })),
    ).toThrow("does not match contract version 1");
    const { coverage: _coverage, ...missingCoverage } = extraction;
    expect(() => decodeDocxExtraction(JSON.stringify(missingCoverage))).toThrow(
      "does not match contract version 1",
    );
    expect(() =>
      decodeDocxRestorationPlan(
        JSON.stringify({ ...restorationPlan, candidateCount: -1 }),
      ),
    ).toThrow("does not match contract version 1");
  });
});

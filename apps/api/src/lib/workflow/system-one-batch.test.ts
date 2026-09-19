import { describe, expect, test } from "bun:test";

import type { FolioAIBlock } from "@stll/folio-core/server";

import { toSafeId } from "@/api/lib/branded-types";
import type { AnswerOutcome } from "@/api/lib/workflow/decisions/answer-questions";
import {
  decodeSystemOneAnswers,
  planSystemOneAnswers,
} from "@/api/lib/workflow/decisions/answer-questions";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import type {
  PreparedDocxFile,
  PreparedExtractedTextFile,
  PreparedInputFile,
  PreparedPdfFile,
} from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";
import {
  outputFromSystemOneOutcomes,
  questionsFromProperties,
  sourcesFromPreparedFiles,
  splitPropertiesForSystemOne,
  SYSTEM_ONE_BATCH_LANGUAGE,
  systemOneDocumentHeader,
} from "@/api/lib/workflow/system-one-batch";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const fieldId = toSafeId<"field">("file-field-0");
const propertyId = (value: string) => toSafeId<"property">(value);

const block = (id: string, text: string): FolioAIBlock => ({
  id,
  kind: "paragraph",
  text,
});

const docxFile: PreparedDocxFile = {
  kind: "docx",
  fileFieldId: fieldId,
  fileId: "file-0",
  simplifiedName: "F0",
  blocks: [
    block("b1", "The purchase price is 1 250 000 CZK."),
    block("b2", "   "),
    block("b3", "The agreement was signed on 12 March 2019."),
  ],
};

const extractedTextFile: PreparedExtractedTextFile = {
  kind: "extracted-text",
  fileFieldId: fieldId,
  fileId: "file-1",
  simplifiedName: "F1",
  content: "First paragraph.\n\n  \n\nSecond paragraph.\n",
};

const property = (
  id: string,
  content: AIBatchProperty["content"],
): AIBatchProperty => ({
  id: propertyId(id),
  status: "stale",
  content,
  dependencies: [],
  tool: { version: 1, type: "ai-model", prompt: `What is ${id}?` },
});

const singleSelect = property("col-select", {
  version: 1,
  type: "single-select",
  options: [{ value: "Purchase agreement", color: "gray" }],
  fallback: null,
});
const dateProperty = property("col-date", { version: 1, type: "date" });
const intProperty = property("col-int", { version: 1, type: "int" });
const textProperty = property("col-text", { version: 1, type: "text" });

const answered = (
  answer: string,
  sourceId: string | null,
  confidence: number,
): AnswerOutcome => ({
  state: "answered",
  answer,
  probability: 0.9,
  confidence,
  sourceId,
  rationale: 'Jev chose "Purchase agreement" at 90%.',
});

describe("sourcesFromPreparedFiles", () => {
  test("DOCX blocks become one source per block, cited by block id", async () => {
    const { sources, locators } = await sourcesFromPreparedFiles(
      [docxFile],
      [],
    );

    expect(sources.map((source) => source.id)).toEqual(["F0#b1", "F0#b3"]);
    expect(sources.at(0)?.text).toBe("The purchase price is 1 250 000 CZK.");
    expect(locators.get("F0#b1")).toEqual({
      type: "cited",
      file: "F0",
      citation: "b1",
    });
  });

  test("DOCX block source ids stay distinct when files reuse block ids", async () => {
    const secondDocx: PreparedDocxFile = {
      ...docxFile,
      fileId: "file-3",
      simplifiedName: "F2",
      blocks: [block("b1", "A second file's block")],
    };

    const { sources, locators } = await sourcesFromPreparedFiles(
      [docxFile, secondDocx],
      [],
    );

    expect(sources.map((source) => source.id)).toEqual([
      "F0#b1",
      "F0#b3",
      "F2#b1",
    ]);
    expect(locators.get("F0#b1")).toEqual({
      type: "cited",
      file: "F0",
      citation: "b1",
    });
    expect(locators.get("F2#b1")).toEqual({
      type: "cited",
      file: "F2",
      citation: "b1",
    });
  });

  test("extracted text splits on blank lines and carries no citation", async () => {
    const { sources, locators } = await sourcesFromPreparedFiles(
      [extractedTextFile],
      [],
    );

    expect(sources).toEqual([
      { id: "F1#1", text: "First paragraph." },
      { id: "F1#2", text: "Second paragraph." },
    ]);
    expect(locators.get("F1#1")).toEqual({ type: "uncited" });
  });

  test("text inputs are sources without a locator", async () => {
    const textInputs: TextInput[] = [
      { propertyId: propertyId("col-party"), value: " Acme s.r.o. " },
      { propertyId: propertyId("col-empty"), value: "   " },
    ];

    const { sources, locators } = await sourcesFromPreparedFiles(
      [],
      textInputs,
    );

    expect(sources).toEqual([{ id: "input-col-party", text: "Acme s.r.o." }]);
    expect(locators.get("input-col-party")).toEqual({ type: "uncited" });
  });

  test("a PDF page is a source cited by its bates stamp", async () => {
    // The fixture's second page carries no text layer, so the stamps show
    // that an id follows the page number, not the source order.
    const content = new Uint8Array(
      await Bun.file(
        `${import.meta.dir}/../search/__fixtures__/mixed-3pages.pdf`,
      ).arrayBuffer(),
    );
    const pdfFile: PreparedPdfFile = {
      kind: "pdf",
      fileFieldId: fieldId,
      fileId: "file-2",
      simplifiedName: "F0",
      content,
      pageCount: 3,
      mimeType: PDF_MIME_TYPE,
    };

    const { sources, locators } = await sourcesFromPreparedFiles([pdfFile], []);

    expect(sources.map((source) => source.id)).toEqual(["F0-0001", "F0-0003"]);
    expect(sources.at(0)?.text).toContain("Native text page one");
    expect(locators.get("F0-0003")).toEqual({
      type: "cited",
      file: "F0",
      citation: "F0-0003",
    });
  });

  test("files come before text inputs, in prompt order", async () => {
    const files: PreparedInputFile[] = [docxFile, extractedTextFile];
    const { sources } = await sourcesFromPreparedFiles(files, [
      { propertyId: propertyId("col-party"), value: "Acme s.r.o." },
    ]);

    expect(sources.map((source) => source.id)).toEqual([
      "F0#b1",
      "F0#b3",
      "F1#1",
      "F1#2",
      "input-col-party",
    ]);
  });
});

describe("splitPropertiesForSystemOne", () => {
  test("every kind but text is a System One question", () => {
    const split = splitPropertiesForSystemOne([
      singleSelect,
      textProperty,
      dateProperty,
      intProperty,
    ]);

    expect(split.systemOne.map((entry) => entry.id)).toEqual([
      singleSelect.id,
      dateProperty.id,
      intProperty.id,
    ]);
    expect(split.generative.map((entry) => entry.id)).toEqual([
      textProperty.id,
    ]);
  });
});

describe("outputFromSystemOneOutcomes", () => {
  const locators = new Map([
    ["F0#b1", { type: "cited", file: "F0", citation: "b1" } as const],
    ["F1#1", { type: "uncited" } as const],
  ]);

  test("an answer from a DOCX block carries a citation the validators accept", () => {
    const { output, fallbackPropertyIds } = outputFromSystemOneOutcomes({
      properties: [singleSelect],
      outcomes: new Map([
        [singleSelect.id, answered("Purchase agreement", "F0#b1", 0.9)],
      ]),
      locators,
    });

    expect(fallbackPropertyIds).toEqual([]);
    const entry = output[singleSelect.id];
    expect(entry?.answer).toBe("Purchase agreement");
    expect(entry?.justification).toEqual([
      {
        file: "F0",
        statements: [
          {
            text: 'Jev chose "Purchase agreement" at 90%.',
            citations: ["b1"],
          },
        ],
      },
    ]);

    const filenames: JustificationFilenames = [
      {
        kind: "docx-folio",
        original: "file-0",
        simplified: "F0",
        fileFieldId: fieldId,
        blocksById: new Map([["b1", "The purchase price is 1 250 000 CZK."]]),
      },
    ];
    const normalized = normalizeJustification({
      filenames,
      justification: entry?.justification ?? [],
    }).unwrap();

    expect(normalized?.content.blocks).toEqual([
      {
        kind: "docx-folio",
        fileFieldId: fieldId,
        statements: [
          {
            text: 'Jev chose "Purchase agreement" at 90%.',
            citations: [
              {
                citationStatus: "verified",
                blockId: "b1",
                text: "The purchase price is 1 250 000 CZK.",
              },
            ],
          },
        ],
      },
    ]);
  });

  test("an answer from extracted text is written without a citation", () => {
    const { output } = outputFromSystemOneOutcomes({
      properties: [singleSelect],
      outcomes: new Map([
        [singleSelect.id, answered("Purchase agreement", "F1#1", 0.9)],
      ]),
      locators,
    });

    expect(output[singleSelect.id]).toEqual({
      answer: "Purchase agreement",
      justification: [],
    });
  });

  test("an undecided outcome falls back to the generative model", () => {
    const { output, fallbackPropertyIds } = outputFromSystemOneOutcomes({
      properties: [singleSelect, dateProperty],
      outcomes: new Map<string, AnswerOutcome>([
        [singleSelect.id, { state: "undecided", reason: "below-floor" }],
      ]),
      locators,
    });

    // The unplanned date question has no outcome at all, and falls back too.
    expect(fallbackPropertyIds).toEqual([singleSelect.id, dateProperty.id]);
    expect(output).toEqual({});
  });

  test("with no decision model the whole batch is the generative model's", async () => {
    const { sources, locators: batchLocators } = await sourcesFromPreparedFiles(
      [docxFile],
      [],
    );
    const properties = [singleSelect, dateProperty];
    const questions = questionsFromProperties(properties);
    const plan = planSystemOneAnswers({
      document: systemOneDocumentHeader([docxFile]),
      sources,
      language: SYSTEM_ONE_BATCH_LANGUAGE,
      questions,
    });
    const { decisions } = await decideMany({
      id: "workflow.table-batch",
      orgAIConfig: null,
      state: plan.state,
      questions: plan.questions,
      client: null,
    });

    const { output, fallbackPropertyIds } = outputFromSystemOneOutcomes({
      properties,
      outcomes: decodeSystemOneAnswers({ plan, questions, decisions }),
      locators: batchLocators,
    });

    expect(output).toEqual({});
    expect(fallbackPropertyIds).toEqual([singleSelect.id, dateProperty.id]);
  });

  test("not stated above the floor is a null answer, not a fallback", () => {
    const { output, fallbackPropertyIds } = outputFromSystemOneOutcomes({
      properties: [dateProperty],
      outcomes: new Map<string, AnswerOutcome>([
        [
          dateProperty.id,
          {
            state: "not_stated",
            confidence: 0.8,
            rationale: "Jev found no answer in the text (80% confidence).",
          },
        ],
      ]),
      locators,
    });

    expect(fallbackPropertyIds).toEqual([]);
    expect(output[dateProperty.id]).toEqual({
      answer: null,
      justification: [],
    });
  });
});

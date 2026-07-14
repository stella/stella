import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import type { FolioAIEditAppliedOperation } from "@stll/folio-core/ai-edits";

import { createActiveDocxEditTool } from "@/api/handlers/chat/tools/active-docx-edit-tool";

/**
 * The tool's input schema is derived from folio's exported contract schemas
 * and validation delegates per-operation shape checking to folio's own
 * strict batch parser, so contract conformance is folio's responsibility —
 * the old mirror-parity round-trips are gone. This suite pins what is
 * STELLA behavior: the narrowings applied on top of the folio contract
 * (required `severity`/`area`, no `formatRange`, no `precondition`,
 * optional operation id, strict stella-shaped envelope) and the
 * liberal-mode stripping of stray keys.
 */

const textRange = {
  type: "textRange",
  story: "main",
  blockId: "b-0010",
  startOffset: 0,
  endOffset: 5,
  // Matches folio's normalized-hash pattern (`^h[0-9a-z]+$`).
  selectedTextHash: "h1a2b3",
} as const;

const reviewMeta = { severity: "medium", area: "Names" } as const;

const ACCEPTED_OPERATIONS = [
  {
    ...reviewMeta,
    type: "replaceInBlock",
    blockId: "b-0010",
    find: "old",
    replace: "new",
    comment: { text: "why" },
  },
  {
    ...reviewMeta,
    type: "replaceRange",
    range: textRange,
    replace: "new",
  },
  {
    ...reviewMeta,
    type: "commentOnRange",
    range: textRange,
    comment: { text: "note" },
  },
  {
    ...reviewMeta,
    type: "insertAfterBlock",
    blockId: "b-0010",
    text: "Inserted paragraph",
    inheritFormatting: true,
    pageBreakBefore: false,
    styleId: "ClauseHeading1",
  },
  {
    ...reviewMeta,
    type: "insertBeforeBlock",
    blockId: "b-0010",
    text: "Inserted paragraph",
  },
  {
    ...reviewMeta,
    type: "replaceBlock",
    blockId: "b-0010",
    text: "Replacement paragraph",
    preserveFormatting: true,
  },
  {
    ...reviewMeta,
    type: "deleteBlock",
    blockId: "b-0010",
  },
  {
    ...reviewMeta,
    type: "commentOnBlock",
    blockId: "b-0010",
    quote: "old",
    comment: { text: "note" },
  },
  {
    ...reviewMeta,
    type: "insertSignatureTable",
    blockId: "b-0010",
    position: "before",
    parties: [{ name: "ACME s.r.o.", signatory: "Jan Novák", title: "CEO" }],
  },
] as const;

const validateInput = async (input: unknown) => {
  const tool = createActiveDocxEditTool();
  if (tool.inputSchema === undefined) {
    throw new TypeError("Expected active DOCX edit input schema");
  }
  return await tool.inputSchema["~standard"].validate(input);
};

const validateOutput = async (output: unknown) => {
  const tool = createActiveDocxEditTool();
  if (tool.outputSchema === undefined) {
    throw new TypeError("Expected active DOCX edit output schema");
  }
  return await tool.outputSchema["~standard"].validate(output);
};

describe("apply-active-docx-edits stella narrowings", () => {
  test("does not send the pinned numeric version as a provider enum", () => {
    const schema = convertSchemaToJsonSchema(
      createActiveDocxEditTool().inputSchema,
    );

    expect(schema?.properties?.["version"]).toMatchObject({ type: "integer" });
    expect(schema?.properties?.["version"]).not.toHaveProperty("enum");
  });

  test("accepts every operation variant available on this surface", async () => {
    const result = await validateInput({
      version: 1,
      operations: ACCEPTED_OPERATIONS,
    });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value.operations).toHaveLength(ACCEPTED_OPERATIONS.length);
    }
  });

  test("model-supplied operation ids survive validation", async () => {
    const result = await validateInput({
      version: 1,
      operations: [
        {
          ...reviewMeta,
          id: "fix-penalty",
          type: "replaceInBlock",
          blockId: "b-0010",
          find: "old",
          replace: "new",
        },
      ],
    });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value.operations.at(0)?.id).toBe("fix-penalty");
    }
  });

  test("an omitted operation id stays absent (executor generates it)", async () => {
    const result = await validateInput({
      version: 1,
      operations: [
        {
          ...reviewMeta,
          type: "deleteBlock",
          blockId: "b-0010",
        },
      ],
    });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value.operations.at(0)?.id).toBeUndefined();
    }
  });

  test("defaults a missing version to the current contract version", async () => {
    const result = await validateInput({
      operations: [
        {
          ...reviewMeta,
          type: "deleteBlock",
          blockId: "b-0010",
        },
      ],
    });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value.version).toBe(1);
    }
  });

  test("rejects an unsupported contract version", async () => {
    const result = await validateInput({
      version: 2,
      operations: [
        {
          ...reviewMeta,
          type: "deleteBlock",
          blockId: "b-0010",
        },
      ],
    });
    expect(result.issues).toBeDefined();
  });

  test("drops batch options the review flow cannot honor (repair layer strips the envelope)", async () => {
    // The strict envelope rejects `mode`/`atomic`/`dryRun`, then the repair
    // layer strips everything but `version`/`operations` and revalidates —
    // so the batch is accepted WITHOUT the option rather than honoring it.
    const result = await validateInput({
      version: 1,
      mode: "direct",
      operations: [
        {
          ...reviewMeta,
          type: "deleteBlock",
          blockId: "b-0010",
        },
      ],
    });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value).toEqual({
        version: 1,
        operations: [{ ...reviewMeta, type: "deleteBlock", blockId: "b-0010" }],
      });
    }
  });

  test("rejects formatRange (deliberately outside this surface's contract subset)", async () => {
    const result = await validateInput({
      version: 1,
      operations: [
        {
          ...reviewMeta,
          type: "formatRange",
          range: textRange,
          formatting: { bold: true },
        },
      ],
    });
    expect(result.issues).toBeDefined();
  });

  test("rejects an unknown operation type", async () => {
    const result = await validateInput({
      version: 1,
      operations: [
        {
          ...reviewMeta,
          type: "renameBlock",
          blockId: "b-0010",
        },
      ],
    });
    expect(result.issues).toBeDefined();
  });

  test("requires severity and area on every operation", async () => {
    const missingSeverity = await validateInput({
      version: 1,
      operations: [{ area: "Names", type: "deleteBlock", blockId: "b-0010" }],
    });
    expect(missingSeverity.issues).toBeDefined();

    const missingArea = await validateInput({
      version: 1,
      operations: [{ severity: "low", type: "deleteBlock", blockId: "b-0010" }],
    });
    expect(missingArea.issues).toBeDefined();

    const emptyArea = await validateInput({
      version: 1,
      operations: [
        { severity: "low", area: "", type: "deleteBlock", blockId: "b-0010" },
      ],
    });
    expect(emptyArea.issues).toBeDefined();
  });

  test("rejects an invalid severity value (via folio's parser)", async () => {
    const result = await validateInput({
      version: 1,
      operations: [
        {
          severity: "critical",
          area: "Names",
          type: "deleteBlock",
          blockId: "b-0010",
        },
      ],
    });
    expect(result.issues).toBeDefined();
  });

  test("strips precondition and stray cross-variant keys instead of bouncing the batch", async () => {
    const result = await validateInput({
      version: 1,
      operations: [
        {
          ...reviewMeta,
          type: "insertAfterBlock",
          blockId: "b-0010",
          text: "Inserted paragraph",
          // Rejected on this surface: stripped, not bounced.
          precondition: { blockTextHash: "h1a2b3" },
          // Valid on insertSignatureTable, not here: stripped.
          position: "after",
        },
      ],
    });
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value.operations).toEqual([
        {
          ...reviewMeta,
          type: "insertAfterBlock",
          blockId: "b-0010",
          text: "Inserted paragraph",
        },
      ]);
    }
  });

  test("accepts a folio-shaped result with receipts and every skip reason", async () => {
    // Typed against folio's receipt so a folio shape change fails here.
    const appliedReceipt: FolioAIEditAppliedOperation = {
      id: "op-1",
      commentId: 3,
      revisionId: 7,
      revisionIds: [7, 8],
    };
    const result = await validateOutput({
      version: 1,
      applied: [appliedReceipt],
      queued: [{ id: "op-2" }],
      skipped: [
        { id: "op-3", reason: "missingBlock" },
        { id: "op-4", reason: "changedBlock" },
        { id: "op-5", reason: "ambiguousFind" },
        { id: "op-6", reason: "missingFind" },
        { id: "op-7", reason: "unsupportedBlock" },
        { id: "op-8", reason: "unsupportedMode" },
        { id: "op-9", reason: "atomicBatchRejected" },
        { id: "op-10", reason: "preconditionFailed" },
        { id: "op-11", reason: "staleRange" },
        { id: "op-12", reason: "emptyOperation" },
        { id: "op-13", reason: "noopOperation" },
        { id: "op-14", reason: "documentNotEditable" },
      ],
    });
    expect(result.issues).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";

import type { FolioAIEditAppliedOperation } from "@stll/folio-core/ai-edits";
import { parseFolioDocumentOperationBatch } from "@stll/folio-core/server";

import { createActiveDocxEditTool } from "@/api/handlers/chat/tools/active-docx-edit-tool";

/**
 * Contract-parity suite: the tool's valibot input schema is a mechanical
 * mirror of folio's versioned document-operation contract
 * (`parseFolioDocumentOperationBatch` in `@stll/folio-core`). The type
 * system cannot see that the two RUNTIME validators agree, so this suite
 * round-trips every operation shape the tool accepts through folio's own
 * strict parser — if folio changes an operation's fields, the mirror must
 * change too or this fails.
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

describe("apply-active-docx-edits folio contract parity", () => {
  test("every accepted operation parses under folio's batch parser", async () => {
    const result = await validateInput({
      version: 1,
      operations: ACCEPTED_OPERATIONS,
    });
    expect(result.issues).toBeUndefined();
    if (result.issues !== undefined) {
      return;
    }

    // Folio requires per-operation ids; the executor fills them in the
    // same way when the model omits them.
    const operations: unknown[] = [];
    for (const [index, operation] of result.value.operations.entries()) {
      operations.push({ id: `op-${String(index + 1)}`, ...operation });
    }
    const batch = {
      version: result.value.version,
      operations,
    };
    expect(() => parseFolioDocumentOperationBatch(batch)).not.toThrow();
  });

  test("model-supplied operation ids survive validation and folio parsing", async () => {
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
    if (result.issues !== undefined) {
      return;
    }
    expect(result.value.operations.at(0)?.id).toBe("fix-penalty");
    expect(() =>
      parseFolioDocumentOperationBatch({
        version: 1,
        operations: result.value.operations,
      }),
    ).not.toThrow();
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

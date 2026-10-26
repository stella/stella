import { describe, expect, test } from "bun:test";

import { USE_CONNECTOR_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";

import {
  getToolApprovalGrant,
  type ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import {
  describeProposedDocxEdits,
  hasAutomaticApproval,
} from "@/components/chat/tool-approval-card.logic";

describe("tool approval grant policy", () => {
  test("does not use preseeded grants for private connector operations", () => {
    const grant = getToolApprovalGrant(USE_CONNECTOR_SECRET_TOOL_NAME);
    const grants = new Set<ToolApprovalGrant>([grant]);

    expect(
      hasAutomaticApproval({
        alwaysApprovedTools: grants,
        canAlwaysAllow: true,
        conversationApprovedTools: grants,
        isPublicOfficialApproval: true,
        name: USE_CONNECTOR_SECRET_TOOL_NAME,
      }),
    ).toBe(false);
  });
});

describe("describeProposedDocxEdits", () => {
  const blockId = "707C9911";

  test("words each kind of edit without its block id", () => {
    const edits = describeProposedDocxEdits([
      {
        type: "replaceInBlock",
        blockId,
        find: "3 months'",
        replace: "60 days'",
      },
      { type: "replaceBlock", blockId, text: "Either party may terminate." },
      { type: "insertAfterBlock", blockId, text: "A new clause." },
      { type: "deleteBlock", blockId },
      {
        type: "commentOnBlock",
        blockId,
        comment: { text: "Check the notice." },
      },
      {
        type: "replaceRange",
        range: {
          type: "textRange",
          story: "main",
          blockId,
          startOffset: 0,
          endOffset: 4,
          selectedTextHash: "h0",
        },
        replace: "60 days'",
      },
    ]);

    expect(edits.map(({ summary }) => summary.key)).toEqual([
      "docxReview.summary.replaceInBlock",
      "docxReview.summary.replaceParagraph",
      "docxReview.summary.insertAfter",
      "docxReview.summary.deleteParagraph",
      "docxReview.summary.commentOnParagraph",
      "docxReview.summary.replaceSelection",
    ]);
    expect(edits.map(({ text }) => text)).toEqual([
      null,
      "Either party may terminate.",
      "A new clause.",
      null,
      "Check the notice.",
      null,
    ]);
    expect(JSON.stringify(edits)).not.toContain(blockId);
  });

  test("leaves out an operation folio cannot read and keeps the rest", () => {
    const edits = describeProposedDocxEdits([
      { type: "replaceBlock" },
      "not an operation",
      { type: "deleteBlock", blockId },
    ]);

    expect(edits.map(({ summary }) => summary.key)).toEqual([
      "docxReview.summary.deleteParagraph",
    ]);
  });
});

import { describe, expect, test } from "bun:test";

import { normalizeLegacyRawToolInputs } from "@/api/handlers/chat/legacy-tool-compat";

describe("legacy chat tool input compatibility", () => {
  test("maps legacy create-document markdown input to source", () => {
    const parts = [
      {
        input: {
          markdown: "@title Legacy agreement",
          name: "Legacy agreement",
          workspaceId: "legacy-matter-id",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ];

    expect(normalizeLegacyRawToolInputs(parts)).toEqual([
      {
        input: {
          name: "Legacy agreement",
          source: "@title Legacy agreement",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ]);
  });

  test("keeps source when both current and legacy fields exist", () => {
    const parts = [
      {
        input: {
          markdown: "@title Old",
          name: "Current agreement",
          source: "@title Current",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ];

    expect(normalizeLegacyRawToolInputs(parts)).toEqual([
      {
        input: {
          name: "Current agreement",
          source: "@title Current",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ]);
  });

  test("fills route ids on legacy create-document success outputs", () => {
    const parts = [
      {
        input: {
          name: "Legacy agreement",
          source: "@title Legacy agreement",
        },
        output: {
          success: true,
          fileName: "Legacy agreement.docx",
          entityRef: "MAT-001/0001.v1",
          matterRef: "MAT-001",
          href: "/workspaces/legacy-matter-id",
          mention: "@Legacy agreement",
        },
        state: "output-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ];

    expect(normalizeLegacyRawToolInputs(parts)).toEqual([
      {
        input: {
          name: "Legacy agreement",
          source: "@title Legacy agreement",
        },
        output: {
          success: true,
          fileName: "Legacy agreement.docx",
          entityId: "",
          fieldId: "",
          workspaceId: "",
          entityRef: "MAT-001/0001.v1",
          matterRef: "MAT-001",
          href: "/workspaces/legacy-matter-id",
          mention: "@Legacy agreement",
        },
        state: "output-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ]);
  });
});

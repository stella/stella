import { describe, expect, test } from "bun:test";

import type { PropertyContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";

import {
  appendActiveFilePromptIfEntityExists,
  buildWorkspacePromptText,
  extractTitle,
} from "./chat-prompt";
import type { WorkspacePromptProperty } from "./chat-prompt";
import type { ChatMessage } from "./types";

const WORKSPACE_ID = toSafeId<"workspace">("ws_prompt_test");

const createProperty = ({
  content,
  id,
  name,
  status = "fresh",
}: {
  content: PropertyContent;
  id: string;
  name: string;
  status?: WorkspacePromptProperty["status"];
}): WorkspacePromptProperty => ({
  content,
  id,
  name,
  status,
});

describe("chat prompt builders", () => {
  test("renders option labels only for initialized select properties", () => {
    const prompt = buildWorkspacePromptText({
      entityCount: 42,
      properties: [
        createProperty({
          content: {
            fallback: null,
            options: [
              { color: "red", value: "Open" },
              { color: "green", value: "Closed" },
            ],
            type: "single-select",
            version: 1,
          },
          id: "prop_stage",
          name: "Stage",
        }),
        createProperty({
          content: {
            fallback: null,
            options: [
              { color: "amber", value: "Urgent" },
              { color: "blue", value: "Client" },
            ],
            type: "multi-select",
            version: 1,
          },
          id: "prop_labels",
          name: "Labels",
        }),
        createProperty({
          content: {
            fallback: null,
            options: [{ color: "orange", value: "Draft" }],
            type: "single-select",
            version: 1,
          },
          id: "prop_hidden",
          name: "Hidden",
          status: "uninitialized",
        }),
      ],
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });

    expect(prompt).toContain(
      "- Stage (id: prop_stage, type: single-select) [options: Open, Closed]",
    );
    expect(prompt).toContain(
      "- Labels (id: prop_labels, type: multi-select) [options: Urgent, Client]",
    );
    expect(prompt).not.toContain("prop_hidden");
  });

  test("does not render option labels for non-select property types", () => {
    const prompt = buildWorkspacePromptText({
      entityCount: 0,
      properties: [
        createProperty({
          content: {
            type: "text",
            version: 1,
          },
          id: "prop_notes",
          name: "Notes",
        }),
      ],
      userContext: null,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Matter Alpha",
    });

    expect(prompt).toContain("- Notes (id: prop_notes, type: text)");
    expect(prompt).not.toContain("type: text) [options:");
  });

  test("appends the active-file prompt only when the entity exists", () => {
    const basePrompt = "Base prompt";
    const activeFile = {
      entityId: toSafeId<"entity">("entity_active"),
      fileName: "Open file.pdf",
    };

    expect(
      appendActiveFilePromptIfEntityExists({
        activeFile,
        entityExists: false,
        prompt: basePrompt,
      }),
    ).toBe(basePrompt);

    expect(
      appendActiveFilePromptIfEntityExists({
        activeFile,
        entityExists: true,
        prompt: basePrompt,
      }),
    ).toContain(
      'The user is currently viewing "Open file.pdf" in the inspector sidebar.',
    );
  });
});

describe("extractTitle", () => {
  test("falls back for empty titles and truncates long text", () => {
    const emptyParts = [
      { text: "   ", type: "text" },
    ] satisfies ChatMessage["parts"];
    const longParts = [
      {
        text: "A".repeat(81),
        type: "text",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(emptyParts)).toBe("New chat");
    expect(extractTitle(longParts)).toBe(`${"A".repeat(80)}…`);
  });

  test("ignores non-text parts when building the title", () => {
    const parts = [
      {
        filename: "attachment.pdf",
        mediaType: "application/pdf",
        type: "file",
        url: "https://example.com/attachment.pdf",
      },
      {
        text: "Useful title",
        type: "text",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(parts)).toBe("Useful title");
  });

  test("strips html markup before returning the title", () => {
    const parts = [
      {
        text: "<p>hello <strong>world</strong></p>",
        type: "text",
      },
    ] satisfies ChatMessage["parts"];

    expect(extractTitle(parts)).toBe("hello world");
  });
});

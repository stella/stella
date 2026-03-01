import { describe, expect, test } from "bun:test";

import {
  deserializeAITool,
  serializeAITool,
  type AITool,
} from "@/api/lib/markdown/ai-tool";

describe("ai tool", () => {
  const aiTool: AITool = {
    version: 1,
    type: "ai-model",
    prompt:
      '<p>Extract the agreement date from <mention-component data-id="1REe4KN_SR7Pm0Z_BAAYr" data-label="Documents" data-mention-suggestion-char="@"></mention-component>.</p>',
    dependencies: [
      {
        dependsOnPropertyId: "1REe4KN_SR7Pm0Z_BAAYr",
        condition: null,
      },
    ],
  };

  const serializedPrompt =
    "Extract the agreement date from [@Documents](1REe4KN_SR7Pm0Z_BAAYr).\n";

  test("serialize ai tool", () => {
    const serialized = serializeAITool(aiTool);
    expect(serialized.prompt).toBe(serializedPrompt);
  });

  test("serialize ai tool sanitizes input html", () => {
    const unsafe: AITool = {
      version: 1,
      type: "ai-model",
      prompt:
        '<p>Unsafe <img src="x" onerror="alert(1)" /> <script>alert(2)</script></p>',
      dependencies: [],
    };
    const serialized = serializeAITool(unsafe);
    expect(serialized.prompt).not.toContain("onerror");
    expect(serialized.prompt).not.toContain("<script>");
  });

  test("deserialize ai tool", () => {
    const serialized: AITool = {
      version: 1,
      type: "ai-model",
      prompt: serializedPrompt,
      dependencies: aiTool.dependencies,
    };
    const deserialized = deserializeAITool(serialized);
    expect(deserialized.prompt).toBe(aiTool.prompt);
  });

  test("roundtrip serialize then deserialize", () => {
    const serialized = serializeAITool(aiTool);
    const deserialized = deserializeAITool(serialized);
    expect(deserialized.prompt).toBe(aiTool.prompt);
  });

  test("deserialize treats markdown links not in dependencies as parsed inline (not mention-component)", () => {
    const toolWithMixedLinks: AITool = {
      version: 1,
      type: "ai-model",
      prompt:
        "[@Documents](1REe4KN_SR7Pm0Z_BAAYr) and [external](https://example.com)",
      dependencies: [
        { dependsOnPropertyId: "1REe4KN_SR7Pm0Z_BAAYr", condition: null },
      ],
    };

    const deserialized = deserializeAITool(toolWithMixedLinks);

    expect(deserialized.prompt).toContain(
      '<mention-component data-id="1REe4KN_SR7Pm0Z_BAAYr"',
    );
    expect(deserialized.prompt).toContain("external");
    expect(deserialized.prompt).not.toContain(
      '<mention-component data-id="https://example.com"',
    );
  });

  test("serialize handles prompt with no mention-component tags", () => {
    const plainPrompt: AITool = {
      version: 1,
      type: "ai-model",
      prompt: "<p>Plain text with no mentions</p>",
      dependencies: [],
    };

    const serialized = serializeAITool(plainPrompt);

    expect(serialized.prompt).toBe("Plain text with no mentions\n");
  });

  test("serialize and deserialize handle empty prompt", () => {
    const emptyTool: AITool = {
      version: 1,
      type: "ai-model",
      prompt: "",
      dependencies: [],
    };

    const serialized = serializeAITool(emptyTool);
    const deserialized = deserializeAITool(serialized);

    expect(serialized.prompt).toBe("");
    expect(deserialized.prompt).toBe("");
  });
});

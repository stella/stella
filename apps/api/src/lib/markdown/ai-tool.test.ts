import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import { deserializeAITool, serializeAITool } from "@/api/lib/markdown/ai-tool";
import type { AITool } from "@/api/lib/markdown/ai-tool";

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

  test("deserialize escapes generated mention-component attributes", () => {
    const toolWithHostileLinkText: AITool = {
      version: 1,
      type: "ai-model",
      prompt: '[@" onmouseover="alert(1)](dep)',
      dependencies: [{ dependsOnPropertyId: "dep", condition: null }],
    };

    const deserialized = deserializeAITool(toolWithHostileLinkText);
    const $ = cheerio.load(deserialized.prompt, undefined, false);
    const mention = $("mention-component");

    expect(mention.attr("data-id")).toBe("dep");
    expect(mention.attr("data-label")).toBe('" onmouseover="alert(1)');
    expect(mention.attr("data-mention-suggestion-char")).toBe("@");
    expect(mention.attr("onmouseover")).toBeUndefined();
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

  test("serialize strips dangerous href schemes", () => {
    // eslint-disable-next-line no-script-url
    const jsScheme = "javascript:alert(1)";
    const dataScheme = "data:text/html,<script>alert(2)</script>";
    const xss: AITool = {
      version: 1,
      type: "ai-model",
      prompt: `<p><a href="${jsScheme}">click</a> <a href="${dataScheme}">data</a> <a href="https://safe.example">ok</a></p>`,
      dependencies: [],
    };
    const serialized = serializeAITool(xss);
    expect(serialized.prompt).not.toContain(jsScheme);
    expect(serialized.prompt).not.toContain(dataScheme);
    expect(serialized.prompt).toContain("https://safe.example");
  });

  test("serialize allows tel: and mailto: href schemes", () => {
    const tool: AITool = {
      version: 1,
      type: "ai-model",
      prompt:
        '<p><a href="tel:+1234567890">call</a> <a href="mailto:a@b.com">email</a></p>',
      dependencies: [],
    };
    const serialized = serializeAITool(tool);
    expect(serialized.prompt).toContain("tel:+1234567890");
    expect(serialized.prompt).toContain("mailto:a@b.com");
  });

  test("serialize strips nested disallowed tags", () => {
    const tool: AITool = {
      version: 1,
      type: "ai-model",
      prompt: "<p><div><span>nested text</span></div></p>",
      dependencies: [],
    };
    const serialized = serializeAITool(tool);
    expect(serialized.prompt).not.toContain("<div");
    expect(serialized.prompt).not.toContain("<span");
    expect(serialized.prompt).toContain("nested text");
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

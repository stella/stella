import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (
  lines: readonly string[],
  sourcePath = "apps/api/src/handlers/chat/stream-chat.ts",
) =>
  await lintSingleRule("no-ad-hoc-chat-request", [...lines, ""].join("\n"), {
    sourcePath,
  });

describe.serial("no-ad-hoc-chat-request", () => {
  test("reports the request builders imported outside the request module", async () => {
    expect(
      await lint([
        'import { mergeGenerationOptions as merge, resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";',
        'import { systemPromptsPatch } from "@/api/lib/tanstack-ai-generate";',
        'import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";',
        "export const used = [merge, resolveTanStackTextModel, systemPromptsPatch, projectChatToolSchemasForProvider];",
      ]),
    ).toEqual([1, 2, 3]);
  });

  test("reports system prompts assembled by hand", async () => {
    expect(
      await lint([
        "declare const system: string;",
        "declare const patch: { systemPrompts?: unknown };",
        "declare const build: () => string[];",
        "export const a = { systemPrompts: [system] };",
        "export const b = { systemPrompts: build() };",
        "patch.systemPrompts = [system];",
      ]),
    ).toEqual([4, 5, 6]);
  });

  test("accepts system prompts taken from the request module", async () => {
    expect(
      await lint([
        'import { chatRequestOptions, chatSystemPrompts as prompts } from "@/api/handlers/chat/chat-request";',
        "declare const input: never;",
        "declare const patch: { systemPrompts?: unknown };",
        "export const options = { ...chatRequestOptions(input) };",
        "export const a = { systemPrompts: prompts(input) };",
        "patch.systemPrompts = prompts(input);",
        "export const unrelated = { tools: [], system: 'x' };",
      ]),
    ).toEqual([]);
  });

  test("leaves the request module, tests and other directories alone", async () => {
    const source = [
      'import { systemPromptsPatch } from "@/api/lib/tanstack-ai-generate";',
      "export const a = { systemPrompts: [systemPromptsPatch] };",
    ];
    expect(
      await lint(source, "apps/api/src/handlers/chat/chat-request.ts"),
    ).toEqual([]);
    expect(
      await lint(source, "apps/api/src/handlers/chat/stream-chat.test.ts"),
    ).toEqual([]);
    expect(
      await lint(source, "apps/api/src/lib/tanstack-ai-generate.ts"),
    ).toEqual([]);
  });
});

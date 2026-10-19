import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sourceIndex = sourceFileIndex(SOURCE_ROOT);
const sourceModules = sourceIndex
  .map(({ relativePath }) => relativePath)
  .filter((file) => !/\.(?:test|spec|gen)\./u.test(file));
const sourceOf = (file: string) => {
  const entry = sourceIndex.find(({ relativePath }) => relativePath === file);
  if (entry === undefined) {
    throw new Error(`Missing source module ${file}`);
  }
  return entry.sourceText;
};

const chatEditorModules = `components/ai-prompt-input/ai-prompt-input.tsx
components/ai-suggestions/file-chat-overlay.tsx
components/ai-suggestions/host.tsx
components/chat-input-surface.tsx
components/inspector/chat-tab-panel.tsx
routes/_protected.chat/-components/chat-thread-page.tsx
routes/_protected.chat/index.tsx
routes/dev/-components/chat-long-paste-playground.tsx
routes/knowledge/-components/template-studio-chat.tsx`;

const composerShells = [
  {
    component: "PromptBar",
    module: "components/ai-suggestions/host.tsx",
  },
  {
    component: "GatedChatComposer",
    module: "components/ai-suggestions/gated-chat-composer.tsx",
  },
  {
    component: "ChatInputSurface",
    module: "components/chat-input-surface.tsx",
  },
] as const;

const followupSurfaces = `components/ai-suggestions/file-chat-overlay.tsx
components/inspector/chat-tab-panel.tsx
routes/_protected.chat/-components/chat-thread-page.tsx`;

describe("chat composer census", () => {
  test("pins every chat editor module", () => {
    const discovered = sourceModules.filter((file) => {
      const source = sourceOf(file);
      return (
        /\buseChatEditor\s*\(/u.test(source) ||
        /<PromptEditorContent\b/u.test(source)
      );
    });

    expect(discovered.join("\n")).toBe(chatEditorModules);
  });

  test("pins every shared composer shell", () => {
    for (const { component, module } of composerShells) {
      expect(sourceOf(module)).toMatch(
        new RegExp(`export const ${component}\\b`, "u"),
      );
    }
  });

  test("every follow-up chip surface gives its editor the same follow-up", () => {
    const discovered = sourceModules.filter((file) =>
      /<SuggestedFollowupChips\b/u.test(sourceOf(file)),
    );
    expect(discovered.join("\n")).toBe(followupSurfaces);

    const failures: string[] = [];
    for (const file of discovered) {
      const source = sourceOf(file);
      const sharesFollowupSource =
        /const\s*\{[\s\S]*?suggestedFollowupPrompt[\s\S]*?\}\s*=\s*useSuggestedFollowupPrompts\s*\(/u.test(
          source,
        );
      const givesFollowupToEditor =
        /useChatEditor\s*\(\s*\{[\s\S]*?suggestedFollowupPrompt[\s\S]*?\}\s*\)/u.test(
          source,
        );
      if (!sharesFollowupSource || !givesFollowupToEditor) {
        failures.push(
          `${file} renders SuggestedFollowupChips but its shared composer does not pass suggestedFollowupPrompt to useChatEditor`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});

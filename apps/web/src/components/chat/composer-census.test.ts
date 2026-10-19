import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sourceModules = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SOURCE_ROOT }),
]
  .filter((file) => !/\.(?:test|spec|gen)\./u.test(file))
  .toSorted();
const sourceOf = (file: string) =>
  readFileSync(path.join(SOURCE_ROOT, file), "utf-8");

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

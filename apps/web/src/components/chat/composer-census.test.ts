import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

import type { ChatSend } from "@/components/chat-editor-provider";

type ExpectFalse<T extends false> = T;

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
routes/dev/-components/chat-composer-reference-playground.tsx
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

// Every place that hands a composer draft to a send, by how it does so. Each
// send is typed `ChatSend` (directly, or through `PromptBar`'s `onSubmit`), so
// the compiler makes it say whether the composer keeps the draft. A new entry
// point is added here, typed the same way, with a test for its declines.
const sendEntryPatterns = {
  chatInputSurface: /<ChatInputSurface(?=[\s/>])/gu,
  composerWiring: /\buseChatComposerWiring\(/gu,
  controllerSubmit: /\b\w*[Cc]ontroller(?:\(\))?\.submit\(/gu,
  promptBar: /<PromptBar(?=[\s/>])/gu,
};
const sendEntryPoints = {
  "components/ai-suggestions/file-chat-overlay.tsx": {
    controllerSubmit: 2,
    promptBar: 1,
  },
  "components/ai-suggestions/host.tsx": { composerWiring: 1 },
  "components/chat-input-surface.tsx": { composerWiring: 1 },
  "components/inspector/chat-tab-panel.tsx": {
    controllerSubmit: 1,
    promptBar: 1,
  },
  "routes/_protected.chat/-components/chat-thread-page.tsx": {
    chatInputSurface: 1,
    controllerSubmit: 1,
  },
  "routes/_protected.chat/index.tsx": { chatInputSurface: 1 },
  "routes/dev/-components/chat-composer-reference-playground.tsx": {
    chatInputSurface: 1,
  },
  "routes/dev/-components/chat-long-paste-playground.tsx": {
    chatInputSurface: 1,
  },
  "routes/knowledge/-components/template-studio-chat.tsx": { promptBar: 1 },
} satisfies Record<
  string,
  Partial<Record<keyof typeof sendEntryPatterns, number>>
>;

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

  test("a composer send cannot finish without saying whether the draft is kept", () => {
    type QuietSendIsAllowed = (() => Promise<void>) extends ChatSend
      ? true
      : false;
    type EarlyReturnIsAllowed = ((
      draft: Parameters<ChatSend>[0],
    ) => Promise<undefined | { kind: "sent" }>) extends ChatSend
      ? true
      : false;
    const quietIsAllowed: ExpectFalse<QuietSendIsAllowed> = false;
    const earlyReturnIsAllowed: ExpectFalse<EarlyReturnIsAllowed> = false;
    const declining: ChatSend = async (draft) =>
      draft.html === "" ? { kind: "kept" } : { kind: "sent" };

    expect({ quietIsAllowed, earlyReturnIsAllowed, declining }).toEqual({
      quietIsAllowed: false,
      earlyReturnIsAllowed: false,
      declining,
    });
  });

  test("pins every composer send entry point", () => {
    const discovered: Record<string, Record<string, number>> = {};
    for (const file of sourceModules) {
      const source = sourceOf(file);
      for (const [kind, pattern] of Object.entries(sendEntryPatterns)) {
        const count = source.match(pattern)?.length ?? 0;
        if (count > 0) {
          discovered[file] = { ...discovered[file], [kind]: count };
        }
      }
    }

    expect(discovered).toEqual(sendEntryPoints);
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

import { describe, expect, test } from "bun:test";

import { resolveChatComposerDockControls } from "@/components/chat/chat-composer-dock-controls";

describe("resolveChatComposerDockControls", () => {
  test("shows the globe exactly when web search is available", () => {
    expect(
      resolveChatComposerDockControls({ webSearchAvailable: true })
        .showWebSearch,
    ).toBe(true);
    expect(
      resolveChatComposerDockControls({ webSearchAvailable: false })
        .showWebSearch,
    ).toBe(false);
  });
});

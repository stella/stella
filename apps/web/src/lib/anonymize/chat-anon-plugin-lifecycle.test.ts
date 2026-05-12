import { Plugin, PluginKey } from "@tiptap/pm/state";
import { describe, expect, test } from "bun:test";

import {
  CHAT_ANON_DECORATIONS_PLUGIN_KEY_PREFIX,
  CHAT_ANON_DECORATIONS_PLUGIN_NAME,
  getChatAnonDecorationsPlugin,
} from "@/components/chat/chat-anon-decorations-plugin";
import {
  getProseMirrorPluginKey,
  isChatAnonDecorationsPlugin,
  replaceChatAnonDecorationsPlugin,
} from "@/lib/anonymize/chat-anon-plugin-lifecycle";

const createKeyedPlugin = (name: string) =>
  new Plugin({ key: new PluginKey(name) });

describe("chat anonymization plugin lifecycle", () => {
  test("detects anon decoration plugins across ProseMirror key suffixes", () => {
    const stalePlugin = createKeyedPlugin(CHAT_ANON_DECORATIONS_PLUGIN_NAME);
    const otherPlugin = createKeyedPlugin("other-plugin");

    expect(
      getProseMirrorPluginKey(stalePlugin)?.startsWith(
        CHAT_ANON_DECORATIONS_PLUGIN_KEY_PREFIX,
      ),
    ).toBe(true);
    expect(isChatAnonDecorationsPlugin(stalePlugin)).toBe(true);
    expect(isChatAnonDecorationsPlugin(otherPlugin)).toBe(false);
  });

  test("replaces stale anon decoration plugins instead of appending duplicates", () => {
    const otherPlugin = createKeyedPlugin("other-plugin");
    const stalePluginA = createKeyedPlugin(CHAT_ANON_DECORATIONS_PLUGIN_NAME);
    const stalePluginB = createKeyedPlugin(CHAT_ANON_DECORATIONS_PLUGIN_NAME);
    const activePlugin = getChatAnonDecorationsPlugin();

    const plugins = replaceChatAnonDecorationsPlugin(activePlugin, [
      otherPlugin,
      stalePluginA,
      stalePluginB,
    ]);

    expect(plugins).toEqual([otherPlugin, activePlugin]);
    expect(
      plugins.filter((plugin) =>
        getProseMirrorPluginKey(plugin)?.startsWith(
          CHAT_ANON_DECORATIONS_PLUGIN_KEY_PREFIX,
        ),
      ),
    ).toEqual([activePlugin]);
  });
});

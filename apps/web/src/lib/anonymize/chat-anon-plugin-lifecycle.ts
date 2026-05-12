import type { Plugin } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

import {
  CHAT_ANON_DECORATIONS_PLUGIN_KEY_PREFIX,
  CHAT_ANON_DECORATIONS_PLUGIN_NAME,
  getChatAnonDecorationsPlugin,
} from "@/components/chat/chat-anon-decorations-plugin";

export type ChatAnonPluginEditor = Pick<
  Editor,
  "registerPlugin" | "unregisterPlugin"
>;

type AnonPluginLifecycleGlobals = {
  __stllAnonPluginRefCount?: WeakMap<ChatAnonPluginEditor, number> | undefined;
};

declare global {
  var __stllAnonPluginRefCount:
    | WeakMap<ChatAnonPluginEditor, number>
    | undefined;
}

// HMR can leave mounted React effects alive across module
// re-evaluation. The ref-count map must therefore live beside the
// globally cached ProseMirror plugin, not in the module instance.
const anonLifecycleGlobals: AnonPluginLifecycleGlobals = globalThis;

const anonPluginRefCount = (anonLifecycleGlobals.__stllAnonPluginRefCount ??=
  new WeakMap<ChatAnonPluginEditor, number>());

export const getProseMirrorPluginKey = (plugin: Plugin): string | null => {
  // ProseMirror assigns `plugin.key` at runtime, but the public
  // TypeScript declaration does not expose it. Treat the reflective
  // read as an untrusted boundary and narrow before use.
  const key: unknown = Reflect.get(plugin, "key");
  return typeof key === "string" ? key : null;
};

export const isChatAnonDecorationsPlugin = (plugin: Plugin): boolean =>
  getProseMirrorPluginKey(plugin)?.startsWith(
    CHAT_ANON_DECORATIONS_PLUGIN_KEY_PREFIX,
  ) ?? false;

export const replaceChatAnonDecorationsPlugin = (
  newPlugin: Plugin,
  plugins: Plugin[],
): Plugin[] => {
  const nextPlugins = plugins.filter(
    (plugin) => !isChatAnonDecorationsPlugin(plugin),
  );
  nextPlugins.push(newPlugin);
  return nextPlugins;
};

export const acquireChatAnonDecorationsPlugin = (
  editor: ChatAnonPluginEditor,
): void => {
  const current = anonPluginRefCount.get(editor) ?? 0;
  editor.registerPlugin(
    getChatAnonDecorationsPlugin(),
    replaceChatAnonDecorationsPlugin,
  );
  anonPluginRefCount.set(editor, current + 1);
};

export const releaseChatAnonDecorationsPlugin = (
  editor: ChatAnonPluginEditor,
): void => {
  const current = anonPluginRefCount.get(editor) ?? 0;
  const next = current - 1;
  if (next > 0) {
    anonPluginRefCount.set(editor, next);
    return;
  }
  anonPluginRefCount.delete(editor);
  editor.unregisterPlugin(CHAT_ANON_DECORATIONS_PLUGIN_NAME);
};

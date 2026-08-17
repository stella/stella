import type { Editor } from "@tiptap/core";
import { Decoration, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { ChatAnonPair } from "@stll/anonymize-chat";

/**
 * Paints round-tripped anonymization spans inside the chat editor
 * itself. The same `pairs` array the live preview gets from the
 * wasm pipeline drives the decorations; positions in the doc are
 * computed by walking text nodes and matching `original`
 * substrings.
 *
 * The extension doesn't run the wasm pipeline. It receives pairs
 * via `setChatAnonDecorationPairs` — the live-preview hook in
 * `chat-thread-page.tsx` is responsible for pushing them.
 *
 * `update: "manual"` means the decoration manager only rebuilds
 * when `setChatAnonDecorationPairs` forces it; between rebuilds it
 * maps existing decoration positions through each transaction
 * (cheap) instead of re-walking the whole doc on every keystroke.
 * The wasm pipeline runs on a debounce; between debounces, mapped
 * decorations stay correctly positioned for already-known tokens —
 * newly typed names just don't highlight until the next debounce
 * tick (acceptable, ~200ms).
 */

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/gu;
const escapeRegex = (value: string) => value.replaceAll(REGEX_SPECIALS, "\\$&");

export const CHAT_ANON_DECORATIONS_NAME = "stllAnonDecorations";

type ChatAnonDecorationsStorage = {
  pairs: readonly ChatAnonPair[];
};

declare module "@tiptap/core" {
  // oxlint-disable-next-line consistent-type-definitions -- module augmentation requires interface for declaration merging
  interface Storage {
    [CHAT_ANON_DECORATIONS_NAME]: ChatAnonDecorationsStorage;
  }
}

export const buildChatAnonDecorations = (
  doc: ProseMirrorNode,
  pairs: readonly ChatAnonPair[],
): Decoration[] => {
  if (pairs.length === 0) {
    return [];
  }
  // Sort longest first so a placeholder original that's a prefix
  // of another (rare) doesn't get partially matched first.
  const sorted = pairs.toSorted(
    (a, b) => b.original.length - a.original.length,
  );
  const pattern = new RegExp(
    sorted.map((pair) => escapeRegex(pair.original)).join("|"),
    "gu",
  );
  const lookup = new Map(
    sorted.map((pair) => [pair.original, pair.placeholder]),
  );
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) {
      return;
    }
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(node.text)) !== null) {
      const placeholder = lookup.get(match[0]);
      decorations.push(
        Decoration.Inline(
          pos + match.index,
          pos + match.index + match[0].length,
          {
            class: "stll-anon-highlight",
            ...(placeholder ? { "data-ph": placeholder } : {}),
          },
        ),
      );
    }
  });
  return decorations;
};

export const ChatAnonDecorations = Extension.create<
  Record<never, never>,
  ChatAnonDecorationsStorage
>({
  name: CHAT_ANON_DECORATIONS_NAME,

  addStorage() {
    return { pairs: [] };
  },

  addDecorations() {
    return {
      update: "manual",
      create: ({ state }) =>
        buildChatAnonDecorations(state.doc, this.storage.pairs),
    };
  },
});

export const setChatAnonDecorationPairs = (
  editor: Editor,
  pairs: readonly ChatAnonPair[],
): void => {
  editor.storage[CHAT_ANON_DECORATIONS_NAME].pairs = pairs;
  editor.commands.updateDecorations(CHAT_ANON_DECORATIONS_NAME);
};

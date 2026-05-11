import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";

import type { ChatAnonPair } from "@/lib/anonymize/chat-anonymize";

/**
 * ProseMirror plugin that paints round-tripped anonymization
 * spans inside the chat editor itself. The same `pairs` array
 * the live preview gets from the wasm pipeline drives the
 * decoration set; positions in the doc are computed by walking
 * text nodes and matching `original` substrings.
 *
 * The plugin doesn't run the wasm pipeline. It receives pairs via
 * a transaction meta — the live-preview hook in
 * `chat-thread-page.tsx` is responsible for dispatching them.
 */

type PluginState = {
  pairs: readonly ChatAnonPair[];
  decorations: DecorationSet;
};

const META_KEY = "stll.anon.pairs";
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/g;
const escapeRegex = (value: string) => value.replaceAll(REGEX_SPECIALS, "\\$&");

// Pin the PluginKey to globalThis so Vite HMR re-evaluating this
// module doesn't allocate a *new* PluginKey while the editor
// still has the previous one installed — that mismatch throws
// "Adding different instances of a keyed plugin" on every code
// change touching this file. The key has no behaviour, only
// identity, so caching it indefinitely is safe.
type AnonGlobals = {
  __stllAnonPluginKey?: PluginKey<PluginState>;
  __stllAnonPlugin?: Plugin<PluginState>;
};
// SAFETY: cross-HMR persistence stash on the global object; keys
// are intentionally underscored to avoid collisions.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const anonGlobals = globalThis as unknown as AnonGlobals;

export const chatAnonDecorationsPluginKey: PluginKey<PluginState> =
  (anonGlobals.__stllAnonPluginKey ??= new PluginKey<PluginState>(
    "stll-anon-decorations",
  ));

const buildDecorations = (
  doc: ProseMirrorNode,
  pairs: readonly ChatAnonPair[],
): DecorationSet => {
  if (pairs.length === 0) {
    return DecorationSet.empty;
  }
  // Sort longest first so a placeholder original that's a prefix
  // of another (rare) doesn't get partially matched first.
  const sorted = [...pairs].sort(
    (a, b) => b.original.length - a.original.length,
  );
  const pattern = new RegExp(
    sorted.map((pair) => escapeRegex(pair.original)).join("|"),
    "g",
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
        Decoration.inline(
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
  return DecorationSet.create(doc, decorations);
};

// Singleton across the whole app *and* across HMR boundaries.
// Multiple `<ChatAnonymizationLayer>` mounts (chat-thread page,
// /chat index, inspector tab, file overlay) all share the same
// Plugin object — installing the same instance into multiple
// editors is fine; installing *different* instances under the
// same PluginKey throws.
export const getChatAnonDecorationsPlugin = (): Plugin<PluginState> =>
  (anonGlobals.__stllAnonPlugin ??= createPlugin());

const createPlugin = (): Plugin<PluginState> =>
  new Plugin<PluginState>({
    key: chatAnonDecorationsPluginKey,
    state: {
      init: () => ({ pairs: [], decorations: DecorationSet.empty }),
      apply(tr, prev) {
        // ProseMirror types `getMeta` as `any`; `setChatAnon-
        // DecorationPairs` is the sole writer for this meta key so
        // the shape is guaranteed at runtime.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
        const meta: readonly ChatAnonPair[] | undefined = tr.getMeta(META_KEY);
        if (meta !== undefined) {
          return { pairs: meta, decorations: buildDecorations(tr.doc, meta) };
        }
        if (!tr.docChanged) {
          return prev;
        }
        // No pairs yet — keep the empty set, skip the regex pass.
        if (prev.pairs.length === 0) {
          return prev;
        }
        // Map existing decoration positions through the
        // transaction (cheap) instead of re-walking the whole doc
        // on every keystroke. The wasm pipeline runs on a
        // debounce; when fresh pairs land they arrive via meta and
        // trigger a full rebuild above. Between debounces, mapped
        // decorations stay correctly positioned for already-known
        // tokens — newly typed names just don't highlight until
        // the next debounce tick (acceptable, ~200ms).
        return {
          pairs: prev.pairs,
          // ProseMirror's DecorationSet.map remaps existing
          // decoration positions through a transaction; not the
          // Array.prototype.map the lint rule assumes.
          // oxlint-disable-next-line unicorn/no-array-method-this-argument
          decorations: prev.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    props: {
      decorations(state) {
        return chatAnonDecorationsPluginKey.getState(state)?.decorations;
      },
    },
  });

export const setChatAnonDecorationPairs = (
  view: EditorView,
  pairs: readonly ChatAnonPair[],
): void => {
  view.dispatch(view.state.tr.setMeta(META_KEY, pairs));
};

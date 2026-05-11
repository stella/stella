import { useEffect } from "react";

import type { Editor } from "@tiptap/react";

import {
  getChatAnonDecorationsPlugin,
  setChatAnonDecorationPairs,
} from "@/components/chat/chat-anon-decorations-plugin";
import { warmupChatAnonymizeWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import {
  useChatAnonymizePreview,
  useChatDraftText,
} from "@/lib/anonymize/use-chat-anonymize";
import { useChatAnonymizedStore } from "@/lib/chat-anonymized-store";

// Per-editor mount counter for the singleton decoration plugin.
// See the long comment in the install effect below for why this
// has to be a ref count rather than a per-component install.
const anonPluginRefCount = new WeakMap<Editor, number>();

// `unregisterPlugin` accepts a plain name string and filters by
// `name + "$"` prefix internally. That matches every PluginKey
// instance ever created with this name — each Vite HMR cycle
// that re-evaluates the plugin module mints a new key from
// ProseMirror's per-name counter ("stll-anon-decorations$",
// "stll-anon-decorations$1", "stll-anon-decorations$2", …), so
// passing the current key only removes one of them. Passing the
// name scrubs them all and prevents stale instances from
// colliding with the fresh install.
const ANON_PLUGIN_NAME = "stll-anon-decorations";

const acquireAnonPlugin = (editor: Editor): void => {
  const next = (anonPluginRefCount.get(editor) ?? 0) + 1;
  anonPluginRefCount.set(editor, next);
  if (next !== 1) {
    return;
  }
  editor.unregisterPlugin(ANON_PLUGIN_NAME);
  editor.registerPlugin(getChatAnonDecorationsPlugin());
};

const releaseAnonPlugin = (editor: Editor): void => {
  const current = anonPluginRefCount.get(editor) ?? 0;
  const next = current - 1;
  if (next > 0) {
    anonPluginRefCount.set(editor, next);
    return;
  }
  anonPluginRefCount.delete(editor);
  editor.unregisterPlugin(ANON_PLUGIN_NAME);
};

/**
 * The single integration point that lights up anonymization
 * highlights inside any chat input. Reads the global "anonymized
 * mode" preference, runs the wasm pipeline against the editor's
 * current text (debounced via TanStack Query), and pushes the
 * resulting placeholder pairs into the editor as inline
 * ProseMirror decorations.
 *
 * Call from every surface that mounts its own chat editor (the
 * `/chat` landing page, dedicated thread page, document overlay,
 * inspector chat tab, …) so the in-editor pills are consistent.
 *
 * `workspaceId` only scopes the wasm pipeline / query cache —
 * pass the surface's actual workspace id when there is one,
 * otherwise the thread id or any stable scope label is fine.
 */
export const useChatAnonymizationLayer = ({
  editor,
  workspaceId,
}: {
  editor: Editor | null;
  workspaceId: string;
}): void => {
  const enabled = useChatAnonymizedStore((s) => s.anonymized);

  // Kick off worker boot + dictionary load the moment the user
  // turns on anonymized mode (or mounts a chat surface with it
  // already on), instead of waiting for the first keystroke.
  // The wasm pipeline + name dictionaries take seconds to load
  // cold; doing it eagerly hides that cost behind the user's
  // typing time.
  useEffect(() => {
    if (enabled) {
      warmupChatAnonymizeWorker();
    }
  }, [enabled]);

  // Only subscribe to the editor's text when we'll actually use
  // it — typing with anonymized mode off must not pay any
  // per-keystroke React render cost from this layer.
  const text = useChatDraftText(editor, enabled);
  const { pairs } = useChatAnonymizePreview({
    enabled,
    text,
    workspaceId,
  });

  // Install the plugin directly on the editor instead of going
  // through the chat-editor-provider's `registerExtension` path.
  //
  // The whole app shares one editor instance via
  // `ChatEditorProvider`, but several chat surfaces can render at
  // the same time (the `/chat` page, the inspector chat tab, a
  // document overlay, …) and each one mounts its own
  // `<ChatAnonymizationLayer>`. If every mount blindly called
  // `unregister` + `register`, the same plugin instance ends up
  // appended to the editor's plugins array twice and ProseMirror's
  // `Configuration` forEach throws "Adding different instances of
  // a keyed plugin (stll-anon-decorations$)" — the duplicate-key
  // check fires even when the two entries are the same object.
  //
  // So we ref-count installs per editor: the first mount installs,
  // the last unmount removes, intermediate mounts just bump the
  // counter. WeakMap so editors get GC'd cleanly when their
  // provider unmounts.
  useEffect(() => {
    if (!editor || !enabled) {
      return undefined;
    }
    acquireAnonPlugin(editor);
    return () => {
      releaseAnonPlugin(editor);
    };
  }, [editor, enabled]);

  useEffect(() => {
    if (!editor || !enabled) {
      return;
    }
    setChatAnonDecorationPairs(editor.view, pairs ?? []);
  }, [editor, enabled, pairs]);
};

/**
 * Null-rendering wrapper that owns the anonymization layer's
 * keystroke-driven state. Mounting this as a *sibling* of a chat
 * input — instead of calling `useChatAnonymizationLayer` from the
 * page component itself — keeps the per-keystroke re-render
 * scoped to a leaf that returns `null`, so big page trees don't
 * thrash on every character typed.
 */
export const ChatAnonymizationLayer = ({
  editor,
  workspaceId,
}: {
  editor: Editor | null;
  workspaceId: string;
}): null => {
  useChatAnonymizationLayer({ editor, workspaceId });
  return null;
};

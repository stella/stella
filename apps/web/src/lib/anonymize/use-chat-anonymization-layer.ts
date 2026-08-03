import type { Editor } from "@tiptap/react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { warmupChatAnonymizeWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import {
  clearChatAnonDecorationOwner,
  setActiveChatAnonDecorationOwner,
  updateActiveChatAnonDecorationOwner,
} from "@/lib/anonymize/chat-anon-decoration-owner";
import {
  acquireChatAnonDecorationsPlugin,
  releaseChatAnonDecorationsPlugin,
} from "@/lib/anonymize/chat-anon-plugin-lifecycle";
import {
  useChatAnonymizePreview,
  useChatDraftText,
} from "@/lib/anonymize/use-chat-anonymize";
import { optionalReadonlyArray } from "@/lib/arrays";

/**
 * The single integration point that lights up anonymization
 * highlights inside any chat input. Receives that surface's per-thread
 * anonymization state, runs the wasm pipeline against the editor's
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
  enabled,
  ownerKey,
  workspaceId,
}: {
  editor: Editor | null;
  /**
   * Anonymized state for *this surface*. Each chat surface owns its
   * own per-thread value. Reading from a global store here would let the editor
   * highlight names that the request then forwards raw — and vice
   * versa. Callers pass their own source of truth.
   */
  enabled: boolean;
  /** Stable ChatThreadRef-derived identity for this composer surface. */
  ownerKey: string;
  workspaceId: string;
}): void => {
  // Kick off worker boot + dictionary load the moment the user
  // turns on anonymized mode (or mounts a chat surface with it
  // already on), instead of waiting for the first keystroke.
  // The wasm pipeline + name dictionaries take seconds to load
  // cold; doing it eagerly hides that cost behind the user's
  // typing time.
  useExternalSyncEffect(() => {
    if (enabled) {
      warmupChatAnonymizeWorker();
    }
  }, [enabled]);

  // Only subscribe to the editor's text when we'll actually use
  // it — typing with anonymized mode off must not pay any
  // per-keystroke React render cost from this layer.
  const text = useChatDraftText(editor, enabled);
  const pairs = useChatAnonymizePreview({
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
  // So we ref-count installs per editor: every mount performs an
  // idempotent replace, the last unmount removes. The WeakMap
  // lives on `globalThis` so Vite HMR cannot split bookkeeping
  // across old and new module instances.
  useExternalSyncEffect(() => {
    if (!editor || !enabled) {
      return undefined;
    }
    acquireChatAnonDecorationsPlugin(editor);
    return () => {
      releaseChatAnonDecorationsPlugin(editor);
    };
  }, [editor, enabled]);

  useExternalSyncEffect(() => {
    if (!editor) {
      return undefined;
    }
    const activePairs = optionalReadonlyArray(pairs);
    const activate = () => {
      setActiveChatAnonDecorationOwner({
        editor,
        ownerKey,
        pairs: activePairs,
      });
    };
    editor.on("focus", activate);
    if (editor.isFocused) {
      activate();
    }
    return () => {
      editor.off("focus", activate);
      clearChatAnonDecorationOwner({ editor, ownerKey });
    };
  }, [editor, ownerKey, pairs]);

  useExternalSyncEffect(() => {
    if (!editor) {
      return;
    }
    updateActiveChatAnonDecorationOwner({
      editor,
      ownerKey,
      pairs: optionalReadonlyArray(pairs),
    });
  }, [editor, ownerKey, pairs]);
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
  enabled,
  ownerKey,
  workspaceId,
}: {
  editor: Editor | null;
  enabled: boolean;
  ownerKey: string;
  workspaceId: string;
}): null => {
  useChatAnonymizationLayer({ editor, enabled, ownerKey, workspaceId });
  return null;
};

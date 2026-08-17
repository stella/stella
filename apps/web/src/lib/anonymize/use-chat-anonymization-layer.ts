import type { Editor } from "@tiptap/react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { warmupChatAnonymizeWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import {
  clearChatAnonDecorationOwner,
  setActiveChatAnonDecorationOwner,
  updateActiveChatAnonDecorationOwner,
} from "@/lib/anonymize/chat-anon-decoration-owner";
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
  focused,
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
  /** True only while this surface's composer, rather than another surface, owns focus. */
  focused: boolean;
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
  const activateFocusedOwner = useLatestCallback(() => {
    if (!editor) {
      return;
    }
    setActiveChatAnonDecorationOwner({
      editor,
      ownerKey,
      pairs: optionalReadonlyArray(pairs),
    });
  });

  // The `ChatAnonDecorations` extension is part of the shared
  // chat editor's base extension list (see `chat-editor-provider`),
  // so there is no per-mount install step: with no pairs stored it
  // decorates nothing, and the owner bookkeeping below decides
  // which surface's pairs the editor shows.
  useExternalSyncEffect(() => {
    if (!editor || !focused) {
      return undefined;
    }
    activateFocusedOwner();
    return () => {
      clearChatAnonDecorationOwner({ editor, ownerKey });
    };
  }, [activateFocusedOwner, editor, focused, ownerKey]);

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
  focused,
  ownerKey,
  workspaceId,
}: {
  editor: Editor | null;
  enabled: boolean;
  focused: boolean;
  ownerKey: string;
  workspaceId: string;
}): null => {
  useChatAnonymizationLayer({
    editor,
    enabled,
    focused,
    ownerKey,
    workspaceId,
  });
  return null;
};

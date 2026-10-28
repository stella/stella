import { useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useDebounce } from "use-debounce";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import { readChatDraftText } from "@/lib/anonymize/use-chat-anonymize.logic";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * Watch a TipTap editor's plain-text content. Returns the
 * editor text after each `update` event so the preview sees
 * exactly what would be sent.
 *
 * When `enabled` is false the hook does NOT subscribe — typing
 * with anonymized mode off has zero React re-render cost from
 * this hook.
 */
export const useChatDraftText = (
  editor: Editor | null,
  enabled = true,
): string => {
  const [text, setText] = useState(() =>
    enabled && editor ? readChatDraftText(editor) : "",
  );

  useExternalSyncEffect(() => {
    if (!editor || !enabled) {
      setText("");
      return undefined;
    }
    setText(readChatDraftText(editor));
    const onUpdate = () => {
      setText(readChatDraftText(editor));
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, enabled]);

  return text;
};

const ANON_PREVIEW_DEBOUNCE_MS = 200;

/**
 * Live anonymization preview hook. Debounces the input so we
 * don't kick the wasm pipeline on every keystroke; result is
 * cached by TanStack Query keyed on `(text, workspaceId)` so
 * scrolling back through history doesn't re-run the pipeline.
 *
 * Returns `null` when disabled or empty so the preview UI can
 * render its idle state.
 */
export const useChatAnonymizePreview = ({
  enabled,
  text,
  workspaceId,
}: {
  enabled: boolean;
  text: string;
  workspaceId: string;
}): readonly ChatAnonPair[] | null => {
  const [debouncedText] = useDebounce(text, ANON_PREVIEW_DEBOUNCE_MS);
  const shouldRun = enabled && debouncedText.trim().length > 0;
  const result = useQuery({
    queryKey: ["chat-anon-preview", workspaceId, debouncedText],
    queryFn: async () =>
      await anonymizeChatTextInWorker({ text: debouncedText, workspaceId }),
    enabled: shouldRun,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    // Carry the previous pairs forward while the new wasm pass
    // resolves. Without this, the queryKey change flips `data` to
    // `undefined` and the editor briefly drops every highlight
    // before the new ones snap in — visible as a one-frame flicker
    // every time the user pauses typing.
    placeholderData: keepPreviousData,
  });
  const resultView = queryView(result);
  useQueryViewError(resultView, "useChatAnonymizePreview:query");

  if (!shouldRun) {
    return null;
  }
  return resultView.type === "items" ? resultView.items.pairs : null;
};

import { useEffect, useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useDebounce } from "use-debounce";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";

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
    enabled && editor ? editor.getText() : "",
  );

  useEffect(() => {
    if (!editor || !enabled) {
      setText("");
      return undefined;
    }
    setText(editor.getText());
    const onUpdate = () => {
      setText(editor.getText());
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
}): { pairs: ChatAnonPair[] | null; isPending: boolean } => {
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

  if (!shouldRun) {
    return { pairs: null, isPending: false };
  }
  return {
    pairs: result.data?.pairs ?? null,
    isPending: result.isFetching,
  };
};

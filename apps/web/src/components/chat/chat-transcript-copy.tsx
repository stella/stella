import type { RefObject } from "react";

import { copyChatSelection } from "@/components/chat/chat-transcript-copy.logic";
import { useMountEffect } from "@/hooks/use-effect";

type ChatTranscriptCopyProps = {
  rootRef: RefObject<HTMLElement | null>;
};

export const ChatTranscriptCopy = ({ rootRef }: ChatTranscriptCopyProps) => {
  // The scroll element belongs to the surrounding chat surface.
  useMountEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return undefined;
    }
    const onCopy = (event: ClipboardEvent) => copyChatSelection(event, root);
    // Native copy targets the focused element, which may be outside the
    // selected message. The serializer scopes ownership to both endpoints.
    root.ownerDocument.addEventListener("copy", onCopy);
    return () => {
      root.ownerDocument.removeEventListener("copy", onCopy);
    };
  });
  return null;
};

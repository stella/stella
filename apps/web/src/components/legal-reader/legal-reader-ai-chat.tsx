import { useState } from "react";
import type { ReactNode } from "react";

import { activeLegalFromReaderTarget } from "@/components/ai-suggestions/active-legal-document";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createChatThreadId } from "@/lib/chat-thread-ref";

type LegalReaderAIChatProps = {
  /** The reader's own text, which the composer floats over. */
  children: ReactNode;
  className?: string;
  /** The document on screen, in the terms a citation and a chat use. */
  target: ReaderAnnotationTarget;
};

/**
 * The chat bar the file viewers float over a PDF or a DOCX, over a legal
 * reader. The composer is bound to the document in front of the reader, so a
 * question typed here carries the decision the way one typed over a PDF
 * carries the PDF.
 *
 * Two readers get nothing but their text back: a visitor, because the chat is
 * an account feature and the public shell offers its own way in; and a
 * document the chat has no context type for, because a bar that quietly
 * dropped the document would answer about the words alone.
 */
export const LegalReaderAIChat = ({
  children,
  className,
  target,
}: LegalReaderAIChatProps) => {
  const user = useMaybeAuthenticatedUser();
  const [chatThreadId, setChatThreadId] = useState(createChatThreadId);
  const activeLegal = activeLegalFromReaderTarget(target);
  const bound = user !== null && activeLegal !== null;

  return (
    <FileViewerWithAI
      activeLegal={activeLegal ?? undefined}
      chatThreadId={chatThreadId}
      className={className}
      onChatThreadIdChange={setChatThreadId}
      overlayActivation={
        bound
          ? FILE_CHAT_OVERLAY_ACTIVATION.active
          : FILE_CHAT_OVERLAY_ACTIVATION.deferred
      }
    >
      {children}
    </FileViewerWithAI>
  );
};

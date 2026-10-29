import { useState } from "react";
import type { ReactNode } from "react";

import { useIsMobile } from "@stll/ui/use-mobile";

import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import type { FileChatOverlayActivation } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  activeChatTabThreadId,
  legalDocumentChatTabThreadId,
  readerOverlayActivation,
} from "@/components/legal-reader/legal-reader-ai-chat.logic";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";
import {
  adoptLegalDocumentChatThread,
  ensureLegalDocumentChatThread,
  useLegalDocumentChatThreads,
} from "@/features/chat/legal-document-chat-threads";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

type LegalReaderAIChatProps = {
  /** The owning surface's readiness, independent of inherited authentication. */
  aiMode: "gated" | "enabled";
  /** The document on screen, in the terms the chat carries it by. */
  activeLegal: ActiveLegalDocument;
  /** The reader's own text, which the composer floats over. */
  children: ReactNode;
  className?: string | undefined;
};

/**
 * The chat bar the file viewers float over a PDF or a DOCX, over a legal
 * reader. The composer is bound to the document in front of the reader, so a
 * question typed here carries the decision — or the consolidation — the way
 * one typed over a PDF carries the PDF.
 *
 * A visitor gets the same bar in the same place, without a runtime behind it:
 * the account is asked for when they press it, not by taking the composer
 * away.
 *
 * Both modes render the one viewer, so the text keeps its place in the tree
 * when a member's chat arrives after it: the mode changes the bar, never the
 * document under it.
 */
export const LegalReaderAIChat = ({
  activeLegal,
  aiMode,
  children,
  className,
}: LegalReaderAIChatProps) => {
  const user = useMaybeAuthenticatedUser();
  const { key: documentKey } = activeLegalDocumentRef(activeLegal);
  const binding = useReaderChatBinding({
    bound: aiMode === "enabled" && user !== null,
    documentKey,
  });

  return (
    <FileViewerWithAI
      activeLegal={activeLegal}
      className={className}
      {...binding}
    >
      {children}
    </FileViewerWithAI>
  );
};

type ReaderChatBinding =
  | {
      chatThreadId: ChatThreadId;
      onChatThreadIdChange: (threadId: ChatThreadId) => void;
      overlayActivation: FileChatOverlayActivation;
    }
  | { overlayActivation: typeof FILE_CHAT_OVERLAY_ACTIVATION.gated };

/**
 * The reader's half of "one conversation per document": the composer reads its
 * thread from the owner rather than from state of its own, so the inspector's
 * chat tab about the same document is the same conversation, and closing and
 * reopening either surface continues it instead of starting over.
 */
const useReaderChatBinding = ({
  bound,
  documentKey,
}: {
  bound: boolean;
  documentKey: LegalDocumentChatKey;
}): ReaderChatBinding => {
  const tabThreadId = useInspectorTabsStore((state) =>
    legalDocumentChatTabThreadId({ documentKey, tabs: state.tabs }),
  );
  // Seeded during the render that binds the composer rather than in an
  // effect, so the composer is bound from its first paint. The call is
  // first-wins and idempotent: a repeated render cannot mint a second
  // conversation, and a tab restored from a previous session hands its thread
  // back before a fresh one is minted. A different document is a different
  // conversation, so it gets a seed of its own.
  const [seed, setSeed] = useState<{
    documentKey: LegalDocumentChatKey;
    threadId: ChatThreadId;
  } | null>(null);
  let seededThreadId = seed?.documentKey === documentKey ? seed.threadId : null;
  if (bound && seededThreadId === null) {
    seededThreadId = ensureLegalDocumentChatThread({
      adoptThreadId: tabThreadId,
      documentKey,
    });
    setSeed({ documentKey, threadId: seededThreadId });
  }
  // The owner stays the live source: a new chat started from either surface
  // moves both.
  const ownerThreadId = useLegalDocumentChatThreads(
    (state) => state.threadIdByDocumentKey[documentKey],
  );
  const dockedChatThreadId = useInspectorTabsStore((state) =>
    activeChatTabThreadId({ activeId: state.activeId, tabs: state.tabs }),
  );
  const inspectorMinimized = useInspectorTabsStore((state) => state.minimized);
  // The dock is `hidden md:block`, so below `md` there is no tab on screen to
  // read the conversation in, whatever the store calls active.
  const inspectorDocked = !useIsMobile();

  if (!bound || seededThreadId === null) {
    return { overlayActivation: FILE_CHAT_OVERLAY_ACTIVATION.gated };
  }
  const chatThreadId = ownerThreadId ?? seededThreadId;
  return {
    chatThreadId,
    onChatThreadIdChange: (threadId) => {
      adoptLegalDocumentChatThread({ documentKey, threadId });
    },
    overlayActivation: readerOverlayActivation({
      overlayThreadId: chatThreadId,
      tabOpen: inspectorDocked && !inspectorMinimized,
      tabThreadId: dockedChatThreadId,
    }),
  };
};

import { useState } from "react";
import type { ReactNode } from "react";

import { useIsMobile } from "@stll/ui/use-mobile";

import { activeLegalFromReaderTarget } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  activeChatTabThreadId,
  decisionChatTabThreadId,
  overlayThreadCardVisibility,
} from "@/components/legal-reader/legal-reader-ai-chat.logic";
import {
  adoptDecisionChatThread,
  ensureDecisionChatThread,
  useDecisionChatThreads,
} from "@/features/chat/decision-chat-threads";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";

type LegalReaderAIChatProps = {
  /** The reader's own text, which the composer floats over. */
  children: ReactNode;
  className?: string | undefined;
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
  const activeLegal = activeLegalFromReaderTarget(target);

  if (user === null || activeLegal === null) {
    return (
      <FileViewerWithAI
        className={className}
        overlayActivation={FILE_CHAT_OVERLAY_ACTIVATION.deferred}
      >
        {children}
      </FileViewerWithAI>
    );
  }

  return (
    // A different decision is a different conversation, so it gets its own
    // instance rather than a thread swapped underneath the old one.
    <BoundLegalReaderAIChat
      activeLegal={activeLegal}
      className={className}
      key={activeLegal.decisionId}
    >
      {children}
    </BoundLegalReaderAIChat>
  );
};

type BoundLegalReaderAIChatProps = {
  activeLegal: ActiveLegalDocument;
  children: ReactNode;
  className?: string | undefined;
};

/**
 * The reader's half of "one conversation per decision": the composer reads its
 * thread from the owner rather than from state of its own, so the inspector's
 * chat tab about the same decision is the same conversation, and closing and
 * reopening either surface continues it instead of starting over.
 */
const BoundLegalReaderAIChat = ({
  activeLegal,
  children,
  className,
}: BoundLegalReaderAIChatProps) => {
  const { decisionId } = activeLegal;
  const tabThreadId = useInspectorTabsStore((state) =>
    decisionChatTabThreadId({ decisionId, tabs: state.tabs }),
  );
  // Seeded during the first render rather than in an effect, so the composer
  // is bound from the first paint. The call is first-wins and idempotent: a
  // repeated render cannot mint a second conversation, and a tab restored from
  // a previous session hands its thread back before a fresh one is minted.
  const [seededThreadId] = useState(() =>
    ensureDecisionChatThread({ adoptThreadId: tabThreadId, decisionId }),
  );
  // The owner stays the live source: a new chat started from either surface
  // moves both.
  const chatThreadId = useDecisionChatThreads(
    (state) => state.threadIdByDecisionId[decisionId] ?? seededThreadId,
  );
  const dockedChatThreadId = useInspectorTabsStore((state) =>
    activeChatTabThreadId({ activeId: state.activeId, tabs: state.tabs }),
  );
  const inspectorMinimized = useInspectorTabsStore((state) => state.minimized);
  // The dock is `hidden md:block`, so below `md` there is no tab on screen to
  // read the conversation in, whatever the store calls active.
  const inspectorDocked = !useIsMobile();

  return (
    <FileViewerWithAI
      activeLegal={activeLegal}
      chatThreadId={chatThreadId}
      className={className}
      onChatThreadIdChange={(threadId) => {
        adoptDecisionChatThread({ decisionId, threadId });
      }}
      overlayActivation={FILE_CHAT_OVERLAY_ACTIVATION.active}
      threadPresentation={overlayThreadCardVisibility({
        overlayThreadId: chatThreadId,
        tabOpen: inspectorDocked && !inspectorMinimized,
        tabThreadId: dockedChatThreadId,
      })}
    >
      {children}
    </FileViewerWithAI>
  );
};

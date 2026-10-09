import { useState } from "react";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import {
  ChatEditorProvider,
  useChatEditor,
} from "@/components/chat-editor-provider";
import { composerText } from "@/components/chat-editor-source";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { useMountEffect } from "@/hooks/use-effect";
import { useChatDraftStore } from "@/lib/chat-draft-store";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

const noop = () => undefined;

const PASTED_TEXT = [
  "Lease review: maintenance and notice provisions",
  ...Array.from(
    { length: 22 },
    (_, index) =>
      `Clause ${index + 1}: The tenant shall notify the landlord in writing of any required repair. The landlord shall acknowledge receipt and propose a reasonable completion date.`,
  ),
].join("\n");
const PROMPT = "Review the maintenance obligations in this lease.";
const DRAFT_THREADS = {
  collapsed: {
    scope: "global",
    threadId: toChatThreadId("visual-long-paste-collapsed"),
  },
  expanded: {
    scope: "global",
    threadId: toChatThreadId("visual-long-paste-expanded"),
  },
} as const satisfies Record<string, ChatThreadRef>;

const DraftComposer = ({ threadRef }: { threadRef: ChatThreadRef }) => {
  const controller = useChatEditor({ threadRef });
  return (
    <ChatInputSurface
      controller={controller}
      onSubmit={noop}
      reservedCommands={{ hasPersistedThread: false }}
      variant="large"
    />
  );
};

// Initialize the preview through the chip's real disclosure action, without
// adding a fixture-only state prop to the product component.
const openSentPreview = (element: HTMLElement | null) => {
  const button = element?.querySelector('button[aria-expanded="false"]');
  if (button instanceof HTMLButtonElement) {
    button.click();
  }
};

const SentMessage = ({ state }: { state: "collapsed" | "expanded" }) => (
  <section
    data-playground-section={`chat-long-paste:sent-${state}`}
    ref={state === "expanded" ? openSentPreview : undefined}
  >
    <h2 className="text-muted-foreground mb-2 text-xs">Sent: {state} paste</h2>
    <ChatApprovalContext
      value={{
        activeOrganizationId: "visual-long-paste",
        alwaysApprovedTools: new Set(),
        conversationApprovedTools: new Set(),
        handleAllowInConversation: noop,
        handleAlwaysAllow: noop,
        handleApprove: noop,
        handleDeny: noop,
      }}
    >
      <ChatThreadMessages
        approvalPendingMessageId={null}
        messages={[
          {
            id: "visual-lease-message",
            role: "user",
            parts: [createChatPastedTextPart(PASTED_TEXT)],
          },
        ]}
        onAskUserSubmit={noop}
        onCreateDocumentResolve={noop}
        onOpenCreatedDocument={noop}
        streamdownComponents={{
          a: ({ children, ...props }) => <a {...props}>{children}</a>,
        }}
      />
    </ChatApprovalContext>
  </section>
);

export const ChatLongPastePlayground = () => {
  const [ready, setReady] = useState(false);
  // Seed only the bench's threads before mounting the real editors; never
  // replace a user's draft or generate attachment ids through clipboard events.
  useMountEffect(() => {
    const store = useChatDraftStore.getState();
    store.setDraft(getChatThreadKey(DRAFT_THREADS.collapsed), {
      attachments: [
        { type: "pasted_text", id: "visual-lease-paste", text: PASTED_TEXT },
      ],
      doc: createChatComposerDocument(composerText(PROMPT)),
      updatedAt: 0,
    });
    store.setDraft(getChatThreadKey(DRAFT_THREADS.expanded), {
      attachments: [],
      doc: createChatComposerDocument(
        composerText(`${PROMPT}\n${PASTED_TEXT}`),
      ),
      updatedAt: 0,
    });
    setReady(true);
    return () => {
      store.clearDraft(getChatThreadKey(DRAFT_THREADS.collapsed));
      store.clearDraft(getChatThreadKey(DRAFT_THREADS.expanded));
    };
  });

  if (!ready) {
    return null;
  }

  return (
    <ChatEditorProvider>
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4"
        data-playground-section="chat-long-paste"
      >
        <section data-playground-section="chat-long-paste:draft-collapsed">
          <h2 className="text-muted-foreground mb-2 text-xs">
            Draft: collapsed paste
          </h2>
          <DraftComposer threadRef={DRAFT_THREADS.collapsed} />
        </section>
        <section data-playground-section="chat-long-paste:draft-expanded">
          <h2 className="text-muted-foreground mb-2 text-xs">
            Draft: text restored to composer
          </h2>
          <DraftComposer threadRef={DRAFT_THREADS.expanded} />
        </section>
        <SentMessage state="collapsed" />
        <SentMessage state="expanded" />
      </div>
    </ChatEditorProvider>
  );
};

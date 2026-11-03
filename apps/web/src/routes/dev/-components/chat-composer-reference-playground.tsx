import { useState } from "react";

import type { JSONContent } from "@tiptap/core";

import {
  CHAT_SEND_KEPT,
  ChatEditorProvider,
  useChatEditor,
} from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { useMountEffect } from "@/hooks/use-effect";
import { useChatDraftStore } from "@/lib/chat-draft-store";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { DOCX_MIME } from "@/lib/consts";

import { composerReferenceVariants } from "../-visual-metadata";

const LONG_LABEL =
  "Rámcová smlouva o poskytování služeb – revize protistrany (002).docx";
const SHORT_LABEL = "Plná moc.docx";
// An unbreakable run, as a pasted link or file path arrives.
const LONG_TOKEN = `https://example.test/spis/${"0123456789".repeat(8)}`;

// A mention without a matter id reads nothing from the API, so the bench
// renders offline; the chip draws from the node's own attributes.
const mentionDoc = (
  id: string,
  label: string,
  trailing = " ",
): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: {
            id,
            label,
            category: "entity",
            kind: "document",
            mimeType: DOCX_MIME,
          },
        },
        { type: "text", text: trailing },
      ],
    },
  ],
});

const DOCS = {
  "compact-long": mentionDoc(
    "00000000-0000-4000-8000-000000000701",
    LONG_LABEL,
  ),
  "large-long": mentionDoc("00000000-0000-4000-8000-000000000702", LONG_LABEL),
  "compact-short": mentionDoc(
    "00000000-0000-4000-8000-000000000703",
    SHORT_LABEL,
  ),
  "compact-token": mentionDoc(
    "00000000-0000-4000-8000-000000000704",
    LONG_LABEL,
    ` ${LONG_TOKEN}`,
  ),
} as const satisfies Record<
  keyof typeof composerReferenceVariants,
  JSONContent
>;

const threadRefFor = (state: string): ChatThreadRef => ({
  scope: "global",
  threadId: toChatThreadId(`visual-composer-reference-${state}`),
});

type DraftComposerProps = {
  state: string;
  variant: "compact" | "large";
};

const DraftComposer = ({ state, variant }: DraftComposerProps) => {
  const controller = useChatEditor({ threadRef: threadRefFor(state) });
  return (
    <ChatInputSurface
      controller={controller}
      // The playground sends nowhere, so the draft stays for the next look.
      onSubmit={() => CHAT_SEND_KEPT}
      reservedCommands={{ hasPersistedThread: false }}
      variant={variant}
    />
  );
};

/** Reference chips in a composer as narrow as a docked chat panel. */
export const ChatComposerReferencePlayground = () => {
  const [ready, setReady] = useState(false);
  // Seed only the bench's threads before mounting the real editors.
  useMountEffect(() => {
    const store = useChatDraftStore.getState();
    for (const [state, doc] of Object.entries(DOCS)) {
      store.setDraft(getChatThreadKey(threadRefFor(state)), {
        attachments: [],
        doc,
        updatedAt: 0,
      });
    }
    setReady(true);
    return () => {
      for (const state of Object.keys(DOCS)) {
        store.clearDraft(getChatThreadKey(threadRefFor(state)));
      }
    };
  });

  if (!ready) {
    return null;
  }

  return (
    <ChatEditorProvider>
      <div className="flex flex-col gap-6 p-4">
        {Object.entries(composerReferenceVariants).map(([state, variant]) => (
          <section
            className="w-75"
            data-playground-section={`chat-composer-reference:${state}`}
            key={state}
          >
            <h2 className="text-muted-foreground mb-2 text-xs">{state}</h2>
            <DraftComposer state={state} variant={variant} />
          </section>
        ))}
      </div>
    </ChatEditorProvider>
  );
};

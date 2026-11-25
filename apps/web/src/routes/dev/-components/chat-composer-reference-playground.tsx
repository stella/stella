import { useState } from "react";

import type { JSONContent } from "@tiptap/core";

import { Button } from "@stll/ui/button";

import {
  CHAT_SEND_KEPT,
  ChatEditorProvider,
  useChatEditor,
} from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { pastedTextChipContent } from "@/components/chat-pasted-text-extension";
import { InlinePill } from "@/components/inline-pill";
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
const DRAFT_POINTS = Array.from(
  { length: 24 },
  (_, index) =>
    `${index + 1}. Check the counterparty's revised indemnity cap against the signed term sheet.`,
);

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
  "pasted-reference-hints": {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          ...pastedTextChipContent({
            source: "skill",
            label: LONG_LABEL,
            text: SHORT_LABEL,
          }),
          ...pastedTextChipContent({
            source: "prompt",
            label: LONG_LABEL,
            text: SHORT_LABEL,
          }),
        ],
      },
    ],
  },
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
  // A draft far taller than the composer's text region, so it scrolls there.
  "compact-draft": {
    type: "doc",
    content: [
      ...(mentionDoc(
        "00000000-0000-4000-8000-000000000705",
        SHORT_LABEL,
        " covers these points:",
      ).content ?? []),
      ...DRAFT_POINTS.map((point) => ({
        type: "paragraph",
        content: [{ type: "text", text: point }],
      })),
    ],
  },
} as const satisfies Record<
  keyof typeof composerReferenceVariants | "pasted-reference-hints",
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
      // The playground has no thread to choose a model for.
      models={null}
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
  const [activations, setActivations] = useState(0);
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
        <section
          className="w-75"
          data-playground-section="pasted-reference-hints"
        >
          <DraftComposer state="pasted-reference-hints" variant="compact" />
        </section>
        <section
          className="flex w-75 flex-col items-start gap-2"
          data-playground-section="inline-pill-hints"
        >
          <Button data-testid="hint-start">Start hint navigation</Button>
          <InlinePill
            ariaLabel="Title fallback"
            className="max-w-24"
            title="Full matter name from title"
            truncate
          >
            A matter name longer than its chip
          </InlinePill>
          <InlinePill
            ariaLabel="Rich hint"
            className="max-w-24"
            onActivate={() => setActivations((value) => value + 1)}
            title="Plain fallback"
            tooltip={<strong>Rich matter context</strong>}
            truncate
          >
            Another matter name longer than its chip
          </InlinePill>
          <InlinePill>No hint or activation</InlinePill>
          <Button data-testid="hint-end">End hint navigation</Button>
          <output data-testid="hint-activations">{activations}</output>
        </section>
      </div>
    </ChatEditorProvider>
  );
};

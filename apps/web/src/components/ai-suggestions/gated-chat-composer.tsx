/**
 * The composer a reader without an account gets over a document: the same
 * docked stack, in the same place, saying the same thing as the live one. It
 * carries no runtime — pressing it asks for the account instead of sending, so
 * nothing anonymous ever reaches an AI endpoint.
 */

// The bar floats over the document here exactly as the live one does, so the
// same integration stylesheet has to come with it: without it the reader
// reserves no trailing space and its last paragraphs sit under the bar. The
// live overlay imports it from its own module, and this chunk is the only
// other place a composer is mounted.
import "@/components/ai-suggestions/file-viewer-with-ai.css";
import {
  FileChatEmptyPlaceholder,
  useFileChatPlaceholder,
} from "@/components/ai-suggestions/file-chat-placeholder";
import type { FileChatPlaceholderSource } from "@/components/ai-suggestions/file-chat-placeholder";
import { useRequireAccount } from "@/components/auth/use-require-account";
import {
  DockedComposer,
  PromptBarPending,
} from "@/components/chat/docked-composer";

export const GatedChatComposer = (props: FileChatPlaceholderSource) => {
  const ensureAccount = useRequireAccount();
  const { placeholder, placeholderAction, sourceLabel } =
    useFileChatPlaceholder(props);

  return (
    <DockedComposer
      bar={
        <PromptBarPending
          activation={{
            // The editor's own placeholder names the document, which is what
            // a screen reader needs from a bar it cannot type into.
            label: placeholder ?? "",
            onActivate: () => {
              ensureAccount();
            },
          }}
        >
          <FileChatEmptyPlaceholder
            placeholderAction={placeholderAction}
            sourceLabel={sourceLabel}
          />
        </PromptBarPending>
      }
    />
  );
};

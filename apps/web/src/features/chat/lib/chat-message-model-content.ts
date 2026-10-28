import { TaggedError } from "better-result";

import { hasChatModelContent } from "@stll/api-contract/chat-message-content";
import type { ChatMessageContentPart } from "@stll/api-contract/chat-message-content";

import type { ChatInputDraft } from "@/components/chat-editor-provider";

/**
 * A send refused before it left the page: the message holds nothing a model
 * reads (a blank line, spaces, a line break), so the provider would reject it.
 * Nothing was sent; the composer keeps the draft.
 */
export class EmptyChatMessageError extends TaggedError(
  "EmptyChatMessageError",
)<{ message: string }> {}

export const emptyChatMessageError = () =>
  new EmptyChatMessageError({
    message: "Chat message has no text or attachment",
  });

const IMAGE_MIME_PREFIX = "image/";
// A reference chip has no text of its own; it reads as its label.
const REFERENCE_CHIP_TAG = /<entity-mention\b[^>]*>/giu;
const CHIP_LABEL = /\bdata-label="([^"]*)"/u;
const TAG = /<[^>]*>/gu;
const WHITESPACE_ENTITY =
  /&(?:nbsp|ensp|emsp|thinsp|#(?:9|10|13|32|160)|#x0*(?:9|a|d|20|a0));/giu;

/**
 * The text a model reads from composer HTML, as far as blankness goes:
 * each reference chip as its label, every other tag as nothing, a
 * whitespace entity as a space. The send endpoint normalizes the HTML
 * itself and applies the same rule to the result, so a chip it cannot
 * resolve is refused there.
 */
export const composerHtmlModelText = (html: string): string =>
  html
    .replace(
      REFERENCE_CHIP_TAG,
      (chip) => ` ${CHIP_LABEL.exec(chip)?.[1] ?? ""} `,
    )
    .replace(TAG, "")
    .replace(WHITESPACE_ENTITY, " ");

/**
 * Whether a composer draft gives the model anything to read: text in its
 * HTML, a pasted passage, or an attached file.
 */
export const chatDraftHasModelContent = ({
  files,
  html,
}: ChatInputDraft): boolean =>
  hasChatModelContent([
    { type: "text", content: composerHtmlModelText(html) },
    ...files.map((file): ChatMessageContentPart => {
      if (file.type === "pasted_text") {
        // Pasted text is sent verbatim, never parsed as HTML.
        return { type: "text", content: file.text };
      }
      return {
        type: file.mimeType.startsWith(IMAGE_MIME_PREFIX)
          ? "image"
          : "document",
      };
    }),
  ]);

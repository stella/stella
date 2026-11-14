import { panic } from "better-result";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_KINDS,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  type ChatLocalRunStepContent,
  type ChatLocalRunStepContentKind,
  chatLocalRunStepContentWindow,
} from "@stll/api-contract/chat-local-run-step-content";

import type { StoredStepContent } from "@/api/lib/desktop-runner/step-contents";
import { toUserFileUrl } from "@/api/lib/user-files/types";

/** A stored row's kind, which the table's check holds to the known kinds. */
const kindOf = (kind: string): ChatLocalRunStepContentKind =>
  CHAT_LOCAL_RUN_STEP_CONTENT_KINDS.find((known) => known === kind) ??
  panic("A stored step content row holds an unknown kind");

type Window = { start: number; limit: number };

/** A stored step as one read answers it. */
export const stepContentAnswer = (
  content: StoredStepContent,
  { start, limit }: Window,
): ChatLocalRunStepContent => {
  switch (content.type) {
    case "arriving":
      return { state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.arriving };
    case "not_stored":
      return { state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notStored };
    case "unstored":
      return {
        state: content.state,
        kind: kindOf(content.kind),
        totalBytes: content.totalBytes,
      };
    case "image":
      return {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored,
        kind: "image",
        totalBytes: content.totalBytes,
        file: {
          url: toUserFileUrl(content.file.id),
          filename: content.file.fileName,
          mimeType: content.file.mimeType,
          ...(content.file.placeholder === null
            ? {}
            : { placeholder: content.file.placeholder }),
        },
      };
    case "text": {
      const kind = kindOf(content.kind);
      if (kind === "image") {
        return panic("A stored step content row holds an image as text");
      }
      const bytes = new TextEncoder().encode(content.text);
      const window = chatLocalRunStepContentWindow(bytes, start, limit);
      return {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored,
        kind,
        totalBytes: content.totalBytes,
        storedBytes: bytes.byteLength,
        start: window.start,
        text: new TextDecoder().decode(
          bytes.subarray(window.start, window.end),
        ),
        nextStart: window.nextStart,
      };
    }
    default:
      content satisfies never;
      return panic("Unhandled stored step content");
  }
};

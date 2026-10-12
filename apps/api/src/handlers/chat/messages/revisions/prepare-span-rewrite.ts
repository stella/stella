import { Result } from "better-result";

import { normalizeRevisionContent } from "@/api/handlers/chat/messages/revisions/normalize-revision-content";
import type { readEditableMessageOnTx } from "@/api/handlers/chat/messages/revisions/read-message";
import { hasUnsettledRevisionContent } from "@/api/handlers/chat/messages/revisions/revision-settlement";
import { findAnchoredSpan } from "@/api/handlers/chat/messages/revisions/span-proposal";
import { THREAD_STORED_CONTENT_SEND_MODE } from "@/api/lib/chat/thread-stored-content-send-mode";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MAX_ANSWER_CONTEXT_LENGTH = 100_000;

type PrepareSpanRewriteOptions = {
  loaded: NonNullable<Awaited<ReturnType<typeof readEditableMessageOnTx>>>;
  body: {
    baseRevision: number;
    start: number;
    end: number;
    selectedTextHash: string;
    instruction: string;
  };
};

type PreparedSpanRewrite = {
  content: ReturnType<typeof normalizeRevisionContent>["content"];
  anchor: NonNullable<ReturnType<typeof findAnchoredSpan>>;
  instruction: string;
  answer: string;
};

export const prepareSpanRewrite = ({
  loaded,
  body,
}: PrepareSpanRewriteOptions): Result<
  PreparedSpanRewrite,
  HandlerError<400 | 403 | 409>
> => {
  if (loaded.message.role !== "assistant") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Only assistant answers can be edited",
      }),
    );
  }
  if (loaded.sendMode === THREAD_STORED_CONTENT_SEND_MODE.anonymized) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Answer rewriting is unavailable for anonymized conversations",
      }),
    );
  }
  const { normalized, content } = normalizeRevisionContent(
    loaded.message.content,
  );
  if (loaded.active || hasUnsettledRevisionContent(normalized)) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Wait for the assistant turn to settle before editing",
      }),
    );
  }
  const anchor = findAnchoredSpan({ content, ...body });
  if (loaded.message.revision !== body.baseRevision || !anchor) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Message selection changed; reload and select the text again",
      }),
    );
  }
  const instruction = body.instruction.trim();
  if (!instruction) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Edit instruction is required",
      }),
    );
  }
  const answer = content.data
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("");
  if (answer.length > MAX_ANSWER_CONTEXT_LENGTH) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Answer is too long for a span rewrite",
      }),
    );
  }
  return Result.ok({ content, anchor, instruction, answer });
};

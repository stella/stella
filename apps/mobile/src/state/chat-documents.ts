import * as v from "valibot";

import { CREATE_DOCUMENT_TOOL_NAME } from "@stll/api-contract/chat";
import {
  buildCreateDocumentDownloadFileName,
  createDocumentInputSchema,
} from "@stll/api-contract/chat-create-document";
import type { CreateDocumentInput } from "@stll/api-contract/chat-create-document";
import { compileLegalSourceToDocument } from "@stll/docx-core";

/** A draft the model wrote with `create-document`, as a thread shows it. */
export type ChatDraftDocument = {
  readonly toolCallId: string;
  readonly fileName: string;
  /** The draft's body in `@`-directives, which the compiler lays out. */
  readonly source: string;
  /** The name it falls back to as its title. */
  readonly name: string;
};

/**
 * What `create-document` answers once its draft is compiled, as the web
 * answers it: the draft and the compiler's report (the normalizations it
 * applied, the constructs it flags), or, when the source does not compile,
 * the errors that stopped it, so the model can fix the source and call it
 * again. `failedMessage` is the person's words for a failed draft.
 */
export type CreateDocumentOutput =
  | {
      readonly success: true;
      readonly destination: "draft";
      readonly fileName: string;
      readonly fixes: readonly unknown[];
      readonly warnings: readonly unknown[];
    }
  | {
      readonly success: false;
      readonly message: string;
      readonly errors: readonly unknown[];
    };

export const compileDraftDocument = (
  input: CreateDocumentInput,
  failedMessage: string,
): CreateDocumentOutput => {
  const compiled = compileLegalSourceToDocument(input.source, {
    titleFallback: draftTitleFallback(input.name),
  });
  return compiled.status === "ok"
    ? {
        success: true,
        destination: "draft",
        fileName: buildCreateDocumentDownloadFileName(input.name),
        fixes: compiled.fixes,
        warnings: compiled.warnings,
      }
    : { success: false, message: failedMessage, errors: compiled.errors };
};

/** The title a draft without one of its own takes. */
export const draftTitleFallback = (name: string): string => name || "Draft";

const draftCallSchema = v.looseObject({
  type: v.literal("tool-call"),
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.literal(CREATE_DOCUMENT_TOOL_NAME),
  input: createDocumentInputSchema,
  output: v.looseObject({
    success: v.literal(true),
    destination: v.literal("draft"),
    fileName: v.string(),
  }),
});

/**
 * The drafts a stored message's `create-document` calls produced. Only a
 * call answered with a draft has one; a failed compile, or one still
 * waiting to be compiled, shows none.
 */
export const draftDocumentsOf = (
  parts: readonly unknown[],
): ChatDraftDocument[] =>
  parts.flatMap((part) => {
    const call = v.safeParse(draftCallSchema, part);
    return call.success
      ? [
          {
            toolCallId: call.output.id,
            fileName: call.output.output.fileName,
            source: call.output.input.source,
            name: call.output.input.name,
          },
        ]
      : [];
  });

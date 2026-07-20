import {
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import {
  modelAcceptsPdfDocumentInput,
  modelAcceptsTextualDocumentInput,
} from "@/api/lib/tanstack-ai-models";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const TEXTUAL_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  TEXT_PLAIN_MIME_TYPE,
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
]);

/**
 * Whether a chat model can receive a hydrated `document` attachment of the
 * given mime type as a content part without the provider adapter throwing.
 *
 * A PDF needs PDF document input; an extracted textual document (text/plain,
 * csv, markdown) needs textual document input, which Mistral's `document_url`
 * path does not provide. Any other mime — notably a raw docx that reached
 * dispatch without being extracted — is never a valid document part, so it is
 * refused rather than handed to an adapter that cannot map it. The chat send
 * gate uses this to reject before dispatch, turning an adapter-level crash
 * into a clean 422 (and keeping a document off a fallback that would crash).
 */
export const modelAcceptsDocumentAttachment = ({
  model,
  mimeType,
}: {
  model: Pick<ResolvedTanStackTextModel, "modelId" | "provider">;
  mimeType: string;
}): boolean => {
  if (mimeType === PDF_MIME_TYPE) {
    return modelAcceptsPdfDocumentInput(model);
  }
  if (TEXTUAL_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return modelAcceptsTextualDocumentInput(model);
  }
  return false;
};

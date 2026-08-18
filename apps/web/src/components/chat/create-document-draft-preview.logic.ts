import type { Document } from "@stll/docx-core";

import { compileCreateDocumentSourceToDocument } from "@/components/chat/create-document-compiler";
import type { CreateDocumentDraftPayload } from "@/components/chat/create-document-draft.logic";

/**
 * Cadence for feeding the streaming source into the DOCX preview. Every
 * accepted source revision reloads the editor (compile, ProseMirror state,
 * layout, paint), so the per-token stream is coalesced to this interval; the
 * final source is applied immediately once streaming ends.
 */
export const CREATE_DOCUMENT_DRAFT_STREAM_PREVIEW_INTERVAL_MS = 200;

const PREVIEW_TITLE_FALLBACK = "Draft";

/** A compiled document the preview can show, with the source it came from. */
export type CreateDocumentDraftPreview = {
  document: Document;
  /** The source that compiled into `document`. */
  source: string;
};

export type CreateDocumentDraftPreviewInput = Pick<
  CreateDocumentDraftPayload,
  "name" | "source" | "status"
>;

/**
 * Preview derived from the draft payload. `preview` is the most recent
 * document that compiled; while the source is still streaming it survives a
 * revision that fails to compile (a directive or table row cut mid-token
 * arrives as `unknown-directive`, `empty-clause-heading`, `ragged-table`,
 * ...), so the editor stays mounted on the previous revision instead of
 * flashing to a placeholder and remounting on the next token.
 */
export type CreateDocumentDraftPreviewState =
  CreateDocumentDraftPreviewInput & {
    preview: CreateDocumentDraftPreview | null;
  };

const toState = (
  { name, source, status }: CreateDocumentDraftPreviewInput,
  preview: CreateDocumentDraftPreview | null,
): CreateDocumentDraftPreviewState => ({ name, source, status, preview });

const matchesSource = (
  state: CreateDocumentDraftPreviewState,
  input: CreateDocumentDraftPreviewInput,
) => state.name === input.name && state.source === input.source;

const compilePreview = (
  input: CreateDocumentDraftPreviewInput,
): CreateDocumentDraftPreview | null => {
  if (!input.source.trim()) {
    return null;
  }
  const compiled = compileCreateDocumentSourceToDocument(input.source, {
    titleFallback: input.name || PREVIEW_TITLE_FALLBACK,
  });
  if (compiled.status !== "ok") {
    return null;
  }
  return { document: compiled.document, source: input.source };
};

/**
 * Advance the preview state for the current payload. Returns `previous`
 * unchanged when nothing relevant moved, so callers can compare identities.
 *
 * A source that fails to compile keeps the last compiled preview only while
 * `status` is `"streaming"`; once the source is final, a failed compile shows
 * no preview (the draft settles as failed elsewhere).
 */
export const advanceCreateDocumentDraftPreview = (
  previous: CreateDocumentDraftPreviewState | null,
  input: CreateDocumentDraftPreviewInput,
): CreateDocumentDraftPreviewState => {
  if (previous !== null && matchesSource(previous, input)) {
    if (previous.status === input.status) {
      return previous;
    }
    const compiledCurrentSource = previous.preview?.source === input.source;
    return toState(
      input,
      compiledCurrentSource || input.status === "streaming"
        ? previous.preview
        : null,
    );
  }
  const compiled = compilePreview(input);
  if (compiled !== null) {
    return toState(input, compiled);
  }
  return toState(
    input,
    input.status === "streaming" ? (previous?.preview ?? null) : null,
  );
};

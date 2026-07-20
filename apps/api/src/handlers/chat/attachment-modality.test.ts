import { describe, expect, test } from "bun:test";

import {
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const { modelAcceptsDocumentAttachment } =
  await import("@/api/handlers/chat/attachment-modality");

// A vision Mistral model: PDF-capable (via document_url) but no textual
// document support. This is the case that crashed the chat stream.
const MISTRAL_VISION = {
  provider: "mistral",
  modelId: "mistral-medium-latest",
} as const;
// A document-capable Anthropic model: accepts both PDF and textual documents.
const ANTHROPIC_DOC = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
} as const;

describe("modelAcceptsDocumentAttachment", () => {
  test("allows a PDF to a Mistral vision model but refuses a textual document", () => {
    expect(
      modelAcceptsDocumentAttachment({
        model: MISTRAL_VISION,
        mimeType: PDF_MIME_TYPE,
      }),
    ).toBe(true);
    for (const mimeType of [
      TEXT_PLAIN_MIME_TYPE,
      TEXT_CSV_MIME_TYPE,
      TEXT_MARKDOWN_MIME_TYPE,
    ]) {
      expect(
        modelAcceptsDocumentAttachment({ model: MISTRAL_VISION, mimeType }),
      ).toBe(false);
    }
  });

  test("allows both PDF and textual documents to a document-capable model", () => {
    expect(
      modelAcceptsDocumentAttachment({
        model: ANTHROPIC_DOC,
        mimeType: PDF_MIME_TYPE,
      }),
    ).toBe(true);
    expect(
      modelAcceptsDocumentAttachment({
        model: ANTHROPIC_DOC,
        mimeType: TEXT_PLAIN_MIME_TYPE,
      }),
    ).toBe(true);
  });

  test("never treats a raw docx as a valid document part", () => {
    // Raw docx reaching dispatch means it was not extracted upstream; no
    // adapter accepts it, so it must be refused for every model.
    for (const model of [MISTRAL_VISION, ANTHROPIC_DOC]) {
      expect(
        modelAcceptsDocumentAttachment({ model, mimeType: DOCX_MIME_TYPE }),
      ).toBe(false);
    }
  });
});

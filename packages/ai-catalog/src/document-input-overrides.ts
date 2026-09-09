import type { OfferedBYOKModelId } from "./index";

export type DocumentInputOverride = {
  /** Whether the model accepts a PDF/file content part. */
  supported: boolean;
  /** Why the live catalogue cannot answer correctly. Dated. */
  reason: string;
};

/**
 * Reviewed document-input corrections for models.dev records that exist but
 * under-report the provider API's file-input support. The generator rejects an
 * override once upstream agrees, so sourced data takes ownership automatically.
 */
export const DOCUMENT_INPUT_OVERRIDES: Partial<
  Record<OfferedBYOKModelId, DocumentInputOverride>
> = {
  "gpt-5.4-mini": {
    supported: true,
    reason:
      "2026-08-20: OpenAI Responses accepts input_file PDF content for this " +
      "vision-capable model; models.dev currently omits the pdf modality",
  },
  "gpt-5.4-nano": {
    supported: true,
    reason:
      "2026-08-20: OpenAI Responses accepts input_file PDF content for this " +
      "vision-capable model; models.dev currently omits the pdf modality",
  },
  "gpt-5.2": {
    supported: true,
    reason:
      "2026-08-20: OpenAI Responses accepts input_file PDF content for this " +
      "vision-capable model; models.dev currently omits the pdf modality",
  },
  "us.amazon.nova-pro-v1:0": {
    supported: true,
    reason:
      "2026-09-09: AWS documents PDF input for Nova Pro through Bedrock " +
      "Converse; models.dev lists text, image and video only",
  },
  "us.amazon.nova-lite-v1:0": {
    supported: true,
    reason:
      "2026-09-09: AWS documents PDF input for Nova Lite through Bedrock " +
      "Converse; models.dev lists text, image and video only",
  },
};

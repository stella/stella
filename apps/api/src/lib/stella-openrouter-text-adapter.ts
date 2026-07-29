import type { ContentPart } from "@tanstack/ai";
import { OpenRouterTextAdapter } from "@tanstack/ai-openrouter";
import type {
  createOpenRouterText,
  OpenRouterConfig,
} from "@tanstack/ai-openrouter";

type OpenRouterModel = Parameters<typeof createOpenRouterText>[0];

const DATA_URL_PREFIX = "data:";

const documentFilename = (part: ContentPart): string | undefined => {
  if (
    part.type !== "document" ||
    typeof part.metadata !== "object" ||
    part.metadata === null ||
    !("filename" in part.metadata) ||
    typeof part.metadata.filename !== "string"
  ) {
    return undefined;
  }
  return part.metadata.filename;
};

/**
 * Stable OpenRouter Chat Completions adapter with document serialization.
 *
 * The upstream adapter intentionally rejects inline documents even though the
 * OpenRouter SDK and Chat Completions API support the `file`/`file_data` wire
 * shape. Keep this override narrow so every other modality and stream behavior
 * remains on the stable upstream adapter.
 */
export class StellaOpenRouterTextAdapter extends OpenRouterTextAdapter<OpenRouterModel> {
  protected override convertContentPart(part: ContentPart) {
    if (part.type !== "document") {
      return super.convertContentPart(part);
    }

    const mimeType = part.source.mimeType || "application/octet-stream";
    const fileData =
      part.source.type === "data" &&
      !part.source.value.startsWith(DATA_URL_PREFIX)
        ? `data:${mimeType};base64,${part.source.value}`
        : part.source.value;
    const filename = documentFilename(part);

    return {
      type: "file" as const,
      file: {
        fileData,
        ...(filename === undefined ? {} : { filename }),
      },
    };
  }
}

export const createStellaOpenRouterText = (
  model: OpenRouterModel,
  apiKey: string,
  config?: Omit<OpenRouterConfig, "apiKey">,
): StellaOpenRouterTextAdapter =>
  new StellaOpenRouterTextAdapter({ apiKey, ...config }, model);

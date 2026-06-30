import {
  extractBytes,
  type ExtractionConfig,
} from "@kreuzberg/node";

export type XbergExtractionResult = {
  text: string | null;
  chunks: Array<{
    text: string;
    index: number;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }>;
  language?: string;
  tables?: unknown[];
  metadata?: Record<string, unknown>;
};

const DEFAULT_CONFIG: ExtractionConfig = {
  useCache: true,
  enableQualityProcessing: true,
  outputFormat: "plain",
  chunking: {
    maxChars: 1000,
    maxOverlap: 100,
    embedding: {
      preset: "balanced",
    },
  },
  ocr: {
    backend: "tesseract",
    language: "eng",
  },
  transcription: {
    enabled: true,
  },
};

export const extractWithXberg = async (
  buffer: Uint8Array,
  mimeType: string,
  config?: Partial<ExtractionConfig>,
): Promise<XbergExtractionResult> => {
  try {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    const result = await extractBytes(
      Buffer.from(buffer),
      mimeType,
      mergedConfig,
    );

    if (!result) {
      return { text: null, chunks: [] };
    }

    const text = result.content || null;

    const chunks = result.chunks?.map((chunk, index) => ({
      text: chunk.content,
      index,
      embedding: chunk.embedding ?? undefined,
      metadata: {
        chunkType: chunk.chunkType,
        ...chunk.metadata,
      },
    })) || [];

    return {
      text,
      chunks,
      language: result.detectedLanguages?.[0],
      tables: result.tables,
      metadata: result.metadata as Record<string, unknown> | undefined,
    };
  } catch (error) {
    console.error("xberg extraction failed:", error);
    return { text: null, chunks: [] };
  }
};

export const isXbergSupported = (mimeType: string): boolean => {
  const supportedPrefixes = [
    "application/pdf",
    "application/vnd.openxmlformats",
    "application/vnd.ms-",
    "text/",
    "image/",
    "message/rfc822",
    "audio/",
    "video/",
  ];

  return supportedPrefixes.some((prefix) => mimeType.startsWith(prefix));
};

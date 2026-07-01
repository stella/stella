import {
  extractBytes,
  OutputFormat,
  type ExtractionConfig,
} from "@kreuzberg/node";

export type XbergExtractionResult = {
  text: string | null;
  chunks: {
    text: string;
    index: number;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }[];
  language?: string;
  tables?: unknown[];
  metadata?: Record<string, unknown>;
};

const DEFAULT_CONFIG: ExtractionConfig = {
  useCache: true,
  enableQualityProcessing: true,
  outputFormat: OutputFormat.Plain,
  chunking: {
    maxCharacters: 1000,
    overlap: 100,
    embedding: {
      model: {
        type: "preset",
        name: "balanced",
      },
    },
  },
  ocr: {
    backend: "tesseract",
    language: ["eng"],
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

    const text = result.content ?? null;

    const chunks =
      result.chunks?.map((chunk, index) => {
        const chunkMetadata: Record<string, unknown> = {
          chunkType: chunk.chunkType,
          ...chunk.metadata,
        };
        const chunkData: {
          text: string;
          index: number;
          embedding?: number[];
          metadata?: Record<string, unknown>;
        } = {
          text: chunk.content,
          index,
          metadata: chunkMetadata,
        };
        if (chunk.embedding) {
          chunkData.embedding = chunk.embedding;
        }
        return chunkData;
      }) ?? [];

    const resultData: XbergExtractionResult = {
      text,
      chunks,
    };
    if (result.detectedLanguages?.[0]) {
      resultData.language = result.detectedLanguages[0];
    }
    if (result.tables) {
      resultData.tables = result.tables;
    }
    if (result.metadata) {
      const serialized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.metadata)) {
        serialized[key] = value;
      }
      resultData.metadata = serialized;
    }
    return resultData;
  } catch {
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

import {
  extractBytes,
  OutputFormat,
  type ExtractionConfig,
} from "@kreuzberg/node";

export type EmbeddingGeneratorConfig = {
  preset?: string;
  chunking?: {
    maxChars?: number;
    maxOverlap?: number;
  };
};

const DEFAULT_CHUNKING = {
  maxChars: 1000,
  maxOverlap: 100,
} as const;

const DEFAULT_PRESET = "balanced";

export type EmbeddingResult = {
  text: string;
  embedding: number[];
  chunkIndex: number;
  tokenCount: number;
};

export const generateEmbeddings = async (
  text: string,
  config?: EmbeddingGeneratorConfig,
): Promise<EmbeddingResult[]> => {
  try {
    const mergedConfig: ExtractionConfig = {
      useCache: false,
      enableQualityProcessing: false,
      outputFormat: OutputFormat.Plain,
      chunking: {
        maxCharacters: config?.chunking?.maxChars ?? DEFAULT_CHUNKING.maxChars,
        overlap: config?.chunking?.maxOverlap ?? DEFAULT_CHUNKING.maxOverlap,
        embedding: {
          model: {
            type: "preset",
            name: config?.preset ?? DEFAULT_PRESET,
          },
        },
      },
    };

    const result = await extractBytes(
      Buffer.from(text, "utf-8"),
      "text/plain",
      mergedConfig,
    );

    if (!result.chunks) {
      return [];
    }

    return result.chunks.map((chunk, index) => ({
      text: chunk.content,
      embedding: chunk.embedding ?? [],
      chunkIndex: index,
      tokenCount: Math.ceil(chunk.content.length / 4),
    }));
  } catch {
    return [];
  }
};

export const generateEmbeddingForText = async (
  text: string,
  config?: EmbeddingGeneratorConfig,
): Promise<number[] | null> => {
  const results = await generateEmbeddings(text, config);
  return results.at(0)?.embedding ?? null;
};

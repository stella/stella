import { extractBytes, type ExtractionConfig } from "@kreuzberg/node";

export type EmbeddingGeneratorConfig = {
  preset?: string;
  chunking?: {
    maxChars?: number;
    maxOverlap?: number;
  };
};

const DEFAULT_CONFIG: EmbeddingGeneratorConfig = {
  preset: "balanced",
  chunking: {
    maxChars: 1000,
    maxOverlap: 100,
  },
};

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
      outputFormat: "plain",
      chunking: {
        maxChars: config?.chunking?.maxChars ?? DEFAULT_CONFIG.chunking!.maxChars!,
        maxOverlap: config?.chunking?.maxOverlap ?? DEFAULT_CONFIG.chunking!.maxOverlap!,
        embedding: {
          preset: config?.preset ?? DEFAULT_CONFIG.preset!,
        },
      },
    };

    const result = await extractBytes(
      Buffer.from(text, "utf-8"),
      "text/plain",
      mergedConfig,
    );

    if (!result || !result.chunks) {
      return [];
    }

    return result.chunks.map((chunk, index) => ({
      text: chunk.content,
      embedding: chunk.embedding ?? [],
      chunkIndex: index,
      tokenCount: Math.ceil(chunk.content.length / 4),
    }));
  } catch (error) {
    console.error("embedding generation failed:", error);
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

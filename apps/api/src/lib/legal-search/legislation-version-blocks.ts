import type { Block } from "@stll/legal-ast/document-ast";

import { legislationDocuments } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import {
  parsePersistedCorpusAst,
  readCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";

/** What a stored consolidation must carry for its blocks to be readable. */
export type LegislationVersionAstRow = {
  id: SafeId<"legislationDocument">;
  astS3Key: string | null;
  documentAst: unknown;
};

/** The columns `readVersionBlocks` reads, for a caller's own select. */
export const versionAstColumns = {
  id: legislationDocuments.id,
  astS3Key: legislationDocuments.astS3Key,
  documentAst: legislationDocuments.documentAst,
};

/**
 * One version's parsed blocks, from object storage when the corpus keeps them
 * there and from the Postgres copy otherwise (the same order the document
 * read uses).
 *
 * Corpus payloads are whole zstd objects, so a block range cannot be read on
 * its own: a caller that needs one reads the version once and slices the
 * result. Never call this inside a database transaction — object storage is
 * a network hop that must not hold one open.
 */
export const readVersionBlocks = async (
  row: LegislationVersionAstRow,
  /** Names the reading endpoint in a payload-unavailable capture. */
  step: string,
): Promise<readonly Block[]> => {
  const { astS3Key } = row;

  const ast =
    corpusStorageMode !== "off" && astS3Key !== null
      ? await readCorpusPayloadOrFallback({
          documentId: row.id,
          key: astS3Key,
          step,
          read: async () => await readCorpusAst(astS3Key),
          fallback: () => parsePersistedCorpusAst(row.documentAst),
        })
      : parsePersistedCorpusAst(row.documentAst);

  return ast !== null && "blocks" in ast ? ast.blocks : [];
};

import { panic } from "better-result";

import { createCorpusAstCache } from "@/api/lib/legal-search/corpus-ast-cache";
import { readSizedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import { LIMITS } from "@/api/lib/limits";

// Shared by reader phases, citation passages and analysis input. Callers gate
// the public row first; packed members also recheck erasure on every hit.
const decisionAstCache = createCorpusAstCache({
  maxHeapBytes: LIMITS.caseLawDecisionAstCacheMaxHeapBytes,
  read: async (key, readTombstones) =>
    await readSizedCorpusAst(key, {
      readTombstones:
        readTombstones ??
        panic("Decision AST cache requires its caller's denial reader"),
    }),
});

export const readCachedDecisionAst = async (
  key: string,
  readTombstones: CorpusTombstoneReader,
) => await decisionAstCache.read(key, readTombstones);

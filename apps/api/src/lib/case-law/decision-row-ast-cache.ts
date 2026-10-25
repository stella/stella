import { createWindowReadCache } from "@/api/lib/files/window-read-cache";
import { parsePersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";
import { LIMITS } from "@/api/lib/limits";
import { recordReadWork } from "@/api/lib/observability/request-work";

type DecisionRowAst = ReturnType<typeof parsePersistedCorpusAst>;
type ReadDecisionRowAstOptions = {
  /** Live row id, update timestamp and payload identity, resolved after admission. */
  key: string;
  read: () => Promise<unknown>;
};

/** The row payload is fetched only after its live metadata names a cache miss. */
export const createDecisionRowAstCache = ({
  maxBytes,
}: {
  maxBytes: number;
}) => {
  const cache = createWindowReadCache<DecisionRowAst>({
    maxBytes,
    sizeOf: (ast) => JSON.stringify(ast).length * 3,
  });
  const inFlight = new Map<string, Promise<DecisionRowAst>>();
  return async ({ key, read }: ReadDecisionRowAstOptions) => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      recordReadWork("cacheHits");
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      recordReadWork("cacheHits");
      return await pending;
    }
    const loading = (async () => {
      const ast = deepFreeze(parsePersistedCorpusAst(await read()));
      cache.set(key, ast);
      return ast;
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, loading);
    return await loading;
  };
};

export const readCachedDecisionRowAst = createDecisionRowAstCache({
  maxBytes: LIMITS.caseLawDecisionAstCacheMaxHeapBytes,
});

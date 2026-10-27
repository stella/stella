import { createWindowReadCache } from "@/api/lib/files/window-read-cache";
import { parsePersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";
import { LIMITS } from "@/api/lib/limits";
import { recordReadWork } from "@/api/lib/observability/request-work";

type DecisionRowAst = ReturnType<typeof parsePersistedCorpusAst>;
type DecisionRowAstLoad =
  DecisionRowAst | typeof DECISION_ROW_AST_VERSION_CHANGED;
export const DECISION_ROW_AST_VERSION_CHANGED = Symbol(
  "decision-row-ast-version-changed",
);
type ReadDecisionRowAstOptions = {
  /** Live row id, update timestamp and payload identity, resolved after admission. */
  key: string;
  read: () => Promise<unknown>;
  onVersionChanged?: () => void;
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
  const inFlight = new Map<string, Promise<DecisionRowAstLoad>>();
  return async ({ key, read, onVersionChanged }: ReadDecisionRowAstOptions) => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      recordReadWork("cacheHits");
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      recordReadWork("cacheHits");
      const result = await pending;
      if (result === DECISION_ROW_AST_VERSION_CHANGED) {
        onVersionChanged?.();
        return null;
      }
      return result;
    }
    const loading = (async () => {
      const value = await read();
      if (value === DECISION_ROW_AST_VERSION_CHANGED) {
        return value;
      }
      const ast = deepFreeze(parsePersistedCorpusAst(value));
      cache.set(key, ast);
      return ast;
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, loading);
    const result = await loading;
    if (result === DECISION_ROW_AST_VERSION_CHANGED) {
      onVersionChanged?.();
      return null;
    }
    return result;
  };
};

export const readCachedDecisionRowAst = createDecisionRowAstCache({
  maxBytes: LIMITS.caseLawDecisionAstCacheMaxHeapBytes,
});

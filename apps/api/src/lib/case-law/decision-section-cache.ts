import { hasBlockInlines, plainTextOf } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { DECISION_ROW_AST_VERSION_CHANGED } from "@/api/lib/case-law/decision-row-ast-cache";
import { createWindowReadCache } from "@/api/lib/files/window-read-cache";
import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { recordReadWork } from "@/api/lib/observability/request-work";

type SectionIndex = Omit<DecisionSection, "text"> & { blockIndices: number[] };

type ReadSectionIndexOptions = {
  /** Live, authorized row identity, including its update and projection version. */
  key: string;
  ast: DocumentAst;
  readSections: () => Promise<
    DecisionSection[] | null | typeof DECISION_ROW_AST_VERSION_CHANGED
  >;
  onVersionChanged?: () => void;
};

/** Section membership travels as block references; the AST carries the text. */
export const createDecisionSectionCache = ({
  maxBytes,
}: {
  maxBytes: number;
}) => {
  const cache = createWindowReadCache<SectionIndex[] | null>({
    maxBytes,
    sizeOf: (value) => JSON.stringify(value).length * 2,
  });
  return async ({
    key,
    ast,
    readSections,
    onVersionChanged,
  }: ReadSectionIndexOptions) => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      recordReadWork("cacheHits");
      return cached;
    }
    const sections = await readSections();
    if (sections === DECISION_ROW_AST_VERSION_CHANGED) {
      onVersionChanged?.();
      return null;
    }
    const blocks = ast.blocks.flatMap((block, index) =>
      hasBlockInlines(block)
        ? [{ index, text: plainTextOf(block.inlines) }]
        : [],
    );
    const index =
      sections?.map(({ text, ...section }) => ({
        ...section,
        blockIndices: blocks.flatMap((block) =>
          block.text.length > 0 && text.includes(block.text)
            ? [block.index]
            : [],
        ),
      })) ?? null;
    deepFreeze(index);
    cache.set(key, index);
    return index;
  };
};

export const readDecisionSectionIndex = createDecisionSectionCache({
  maxBytes: LIMITS.caseLawDecisionSectionCacheMaxHeapBytes,
});

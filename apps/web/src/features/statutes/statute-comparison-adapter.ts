import { compareContent } from "@stll/folio-core";
import type { FolioContentComparisonError } from "@stll/folio-core";
import { diffWordSegments } from "@stll/folio-core/ai-edits";
import type { StatuteComparisonAdapter } from "@stll/legal-ast/statute-comparison-adapter";

/** Keep folio's comparison implementation at the web host boundary. */
export const statuteComparisonAdapter = {
  compare: ({ base, revised }) =>
    compareContent({
      base: { blocks: [...base] },
      revised: { blocks: [...revised] },
    }).map(({ events }) => events),
  diffWords: diffWordSegments,
} satisfies StatuteComparisonAdapter<FolioContentComparisonError>;

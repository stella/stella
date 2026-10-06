import { ReaderFindBar } from "@/components/legal-reader/reader-find-bar";

import type { DocxFind } from "./use-docx-find";

type DocxFindBarProps = {
  find: DocxFind;
};

/** DOCX uses the same floating controls as the other document readers. */
export const DocxFindBar = ({ find }: DocxFindBarProps) => (
  <ReaderFindBar
    activeIndex={find.activeIndex}
    focusRequest={find.focusSeq}
    matchCount={find.summary.count}
    onClose={find.close}
    onNext={() => find.step("next")}
    onPrevious={() => find.step("previous")}
    onQueryChange={find.setQuery}
    query={find.query}
    truncated={find.summary.truncated}
  />
);

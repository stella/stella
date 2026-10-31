import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import type { CaseLawResultsLine } from "@/features/case-law/search-warnings.logic";

type SearchWidenedLineProps = {
  line: CaseLawResultsLine;
  /** Null while the rows below answer an earlier search than the URL does. */
  onSearchEveryWord: (() => void) | null;
};

/**
 * What the search required, when it required less than the reader typed: no
 * judgment is written the way a question is asked, so the words that carry
 * the grammar of the question are not required of it.
 *
 * One muted line above the results and the way back to a search that does
 * require them. The results below are the answer, so the line stays chrome.
 */
export const SearchWidenedLine = ({
  line,
  onSearchEveryWord,
}: SearchWidenedLineProps) => {
  const t = useTranslations();

  return (
    <div className="text-muted-foreground flex max-w-full min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
      {/*
        The sentence reads in the interface's own direction; only the query is
        isolated, because it is the reader's text and may run the other way.
        Isolating the whole line instead would let a Latin query set the
        direction of an Arabic sentence. A long query ends in an ellipsis on
        one line rather than wrapping the toolbar row; the title keeps it whole.
      */}
      <p className="min-w-0 truncate" title={line.query}>
        {t.rich(line.messageKey, {
          bdi: (chunks) => <BidiText>{chunks}</BidiText>,
          query: line.query,
        })}
      </p>
      {onSearchEveryWord === null ? null : (
        <Button onClick={onSearchEveryWord} size="xs" variant="link">
          {t(line.actionKey)}
        </Button>
      )}
    </div>
  );
};

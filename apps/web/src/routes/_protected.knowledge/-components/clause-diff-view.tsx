import { cn } from "@stll/ui/lib/utils";

import type { ParagraphDiff } from "./clause-diff";

type ClauseDiffViewProps = {
  diffs: ParagraphDiff[];
};

const statusBorder = {
  equal: "",
  modified: "border-s-2 border-s-[var(--option-amber)] ps-3",
  added: "border-s-2 border-s-[var(--option-green)] ps-3",
  removed: "border-s-2 border-s-[var(--option-red)] ps-3",
} as const satisfies Record<ParagraphDiff["status"], string>;

export const ClauseDiffView = ({ diffs }: ClauseDiffViewProps) => (
  <div className="space-y-1">
    {diffs.map((para, i) => (
      <p
        className={cn("text-sm leading-relaxed", statusBorder[para.status])}
        // eslint-disable-next-line react/no-array-index-key, react-doctor/no-array-index-as-key -- diffs is a read-only paragraph diff recomputed fresh on every render (whole-list replace); paragraphs are non-interactive with no per-item state.
        key={i}
      >
        {para.segments.map((seg, j) => (
          <span
            className={cn(
              seg.type === "added" && "bg-success/15 dark:bg-success/15",
              seg.type === "removed" &&
                "bg-destructive/15 dark:bg-destructive/15 line-through",
            )}
            // eslint-disable-next-line react/no-array-index-key -- segments is a read-only word-diff recomputed fresh on every render (whole-list replace); spans are non-interactive with no per-item state.
            key={j}
          >
            {seg.text}
          </span>
        ))}
      </p>
    ))}
  </div>
);

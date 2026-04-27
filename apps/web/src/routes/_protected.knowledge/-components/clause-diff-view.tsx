import { cn } from "@stella/ui/lib/utils";

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
        // eslint-disable-next-line react/no-array-index-key
        key={i}
      >
        {para.segments.map((seg, j) => (
          <span
            className={cn(
              seg.type === "added" && "bg-green-100 dark:bg-green-900/30",
              seg.type === "removed" &&
                "bg-red-100 line-through dark:bg-red-900/30",
            )}
            // eslint-disable-next-line react/no-array-index-key
            key={j}
          >
            {seg.text}
          </span>
        ))}
      </p>
    ))}
  </div>
);

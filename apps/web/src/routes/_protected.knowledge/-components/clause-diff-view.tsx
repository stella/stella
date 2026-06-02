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
        key={i}
      >
        {para.segments.map((seg, j) => (
          <span
            className={cn(
              seg.type === "added" && "bg-success/15 dark:bg-success/15",
              seg.type === "removed" &&
                "bg-destructive/15 dark:bg-destructive/15 line-through",
            )}
            key={j}
          >
            {seg.text}
          </span>
        ))}
      </p>
    ))}
  </div>
);

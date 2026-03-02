import { cn } from "@stella/ui/lib/utils";

import type { ParagraphDiff } from "./clause-diff";

type ClauseDiffViewProps = {
  diffs: ParagraphDiff[];
};

const statusBorder: Record<ParagraphDiff["status"], string> = {
  equal: "",
  modified: "border-l-2 border-l-amber-400 pl-3",
  added: "border-l-2 border-l-green-500 pl-3",
  removed: "border-l-2 border-l-red-500 pl-3",
};

export const ClauseDiffView = ({ diffs }: ClauseDiffViewProps) => (
  <div className="space-y-1">
    {diffs.map((para, i) => (
      <p
        className={cn("text-sm leading-relaxed", statusBorder[para.status])}
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional, no stable ID
        key={i}
      >
        {para.segments.map((seg, j) => (
          <span
            className={cn(
              seg.type === "added" && "bg-green-100 dark:bg-green-900/30",
              seg.type === "removed" &&
                "bg-red-100 line-through dark:bg-red-900/30",
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, no stable ID
            key={j}
          >
            {seg.text}
          </span>
        ))}
      </p>
    ))}
  </div>
);

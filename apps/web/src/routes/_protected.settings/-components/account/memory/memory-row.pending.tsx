import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

/** A memory's card (`MemoryRow`): its surface and the gap between lines. */
export const MEMORY_ROW_CLASS =
  "bg-card flex flex-col gap-2 rounded-lg border p-3";

/** The kind chip's box at the card's start. */
export const MEMORY_KIND_CHIP_CLASS =
  "bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 text-xs font-medium";

const MEMORY_CONTENT_WIDTHS = [
  { className: "w-80" },
  { className: "w-64" },
  { className: "w-72" },
] as const;

/**
 * A memory's card while the list loads: the kind chip, a bar on the
 * memory's line and on the line saying where it came from, so the card that
 * arrives takes its place.
 */
export const MemoryRowSkeleton = ({ index }: { index: number }) => (
  <div aria-hidden="true" className={MEMORY_ROW_CLASS}>
    <div className="flex items-start justify-between gap-2">
      <span className={MEMORY_KIND_CHIP_CLASS}>
        <FaceLabelPending className="w-12" />
      </span>
    </div>
    <p className="text-sm">
      <FaceLabelPending
        className={cn(
          MEMORY_CONTENT_WIDTHS[index % MEMORY_CONTENT_WIDTHS.length]
            ?.className,
          "max-w-full",
        )}
      />
    </p>
    <p className="text-xs">
      <FaceLabelPending className="w-40" />
    </p>
  </div>
);

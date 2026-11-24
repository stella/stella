import type { ReactNode } from "react";

/** A label beside a monospace sample: the next matter number, or a document name. */
export const MatterNumberPreview = ({
  children,
  label,
}: {
  label: ReactNode;
  /** The next number, or a bar while it is worked out. */
  children: ReactNode;
}) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground text-xs">{label}</span>
    <span
      className="bg-muted rounded-sm border px-2 py-1 font-mono text-sm tabular-nums"
      dir="ltr"
    >
      {children}
    </span>
  </div>
);

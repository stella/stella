import type { ReactNode } from "react";

/** One labeled value of a correspondence envelope. */
export const EnvelopeField = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="min-w-0 space-y-1">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="text-sm wrap-break-word">{children}</div>
  </div>
);

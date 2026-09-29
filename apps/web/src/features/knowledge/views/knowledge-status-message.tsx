import type { ReactNode } from "react";

/** A one-line status in place of a section: loading, or a failed load. */
export const KnowledgeStatusMessage = ({
  children,
}: {
  children: ReactNode;
}) => (
  <div className="flex flex-1 items-center justify-center p-8">
    <p className="text-muted-foreground text-sm">{children}</p>
  </div>
);

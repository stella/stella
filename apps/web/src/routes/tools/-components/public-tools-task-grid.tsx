import type { ReactNode } from "react";

/** Pending and loaded tasks reserve the same rows, independent of font metrics. */
export const PublicToolsTaskGrid = ({ children }: { children: ReactNode }) => (
  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
    {children}
  </div>
);

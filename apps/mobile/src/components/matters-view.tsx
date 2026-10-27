import { createContext, use, useState } from "react";

import { panic } from "better-result";

/** How the matters list groups its rows: the web's `MattersGroupBy`. */
export type MattersGroupBy = "client" | "none";

type MattersView = {
  readonly groupBy: MattersGroupBy;
  readonly setGroupBy: (groupBy: MattersGroupBy) => void;
};

const MattersViewContext = createContext<MattersView | null>(null);

/**
 * The matters list's view, which the header's menu sets and the list reads.
 * Grouped by client unless changed, as the web's matters list starts.
 */
export const MattersViewProvider = ({ children }: React.PropsWithChildren) => {
  const [groupBy, setGroupBy] = useState<MattersGroupBy>("client");
  return (
    <MattersViewContext value={{ groupBy, setGroupBy }}>
      {children}
    </MattersViewContext>
  );
};

export const useMattersView = (): MattersView =>
  use(MattersViewContext) ??
  panic("useMattersView needs a MattersViewProvider above it");

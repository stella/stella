import { createContext, use, useState } from "react";

import { panic } from "better-result";

/** How the matters list groups its rows: the web's `MattersGroupBy`. */
export type MattersGroupBy = "client" | "none";

type MattersView = {
  readonly groupBy: MattersGroupBy;
  readonly setGroupBy: (groupBy: MattersGroupBy) => void;
  /** The groups folded shut, by key. */
  readonly collapsed: ReadonlySet<string>;
  readonly toggleGroup: (key: string) => void;
};

const MattersViewContext = createContext<MattersView | null>(null);

/**
 * The matters list's view, which the header's menu sets and the list reads.
 * Grouped by client unless changed, as the web's matters list starts, every
 * group open until folded. It sits above the tabs, so a folded group stays
 * folded on the way back to the list.
 */
export const MattersViewProvider = ({ children }: React.PropsWithChildren) => {
  const [groupBy, setGroupBy] = useState<MattersGroupBy>("client");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleGroup = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  };
  return (
    <MattersViewContext
      value={{
        collapsed,
        groupBy,
        setGroupBy,
        toggleGroup,
      }}
    >
      {children}
    </MattersViewContext>
  );
};

export const useMattersView = (): MattersView =>
  use(MattersViewContext) ??
  panic("useMattersView needs a MattersViewProvider above it");

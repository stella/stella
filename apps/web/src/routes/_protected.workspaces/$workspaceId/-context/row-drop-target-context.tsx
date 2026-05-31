import { createContext, useContext, useState } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";

type RowDropTargetState = {
  /** The entityId of the row currently being hovered as a drop target, or null */
  activeRowId: string | null;
  setActiveRowId: (rowId: string | null) => void;
};

const RowDropTargetContext = createContext<RowDropTargetState | null>(null);

export const RowDropTargetProvider = ({ children }: PropsWithChildren) => {
  const [activeRowId, setActiveRowId] = useState<string | null>(null);

  return (
    <RowDropTargetContext.Provider value={{ activeRowId, setActiveRowId }}>
      {children}
    </RowDropTargetContext.Provider>
  );
};

export const useRowDropTarget = (): RowDropTargetState => {
  const context = useContext(RowDropTargetContext);
  if (!context) {
    panic("useRowDropTarget must be used within a RowDropTargetProvider");
  }
  return context;
};

/**
 * Hook that returns true if any row is currently a drop target.
 * Used by WorkspaceDropZone to suppress its overlay when a row handles the drop.
 */
export const useIsRowDropTargetActive = (): boolean => {
  const context = useContext(RowDropTargetContext);
  return context?.activeRowId !== null;
};

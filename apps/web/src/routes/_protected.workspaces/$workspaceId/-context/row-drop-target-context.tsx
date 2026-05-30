import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";

type RowDropTargetState = {
  /** The entityId of the row currently being hovered as a drop target, or null */
  activeRowId: string | null;
  setActiveRowId: (rowId: string | null) => void;
};

const RowDropTargetContext = createContext<RowDropTargetState | null>(null);

// Module-scoped ref of the last committed active-row id. Pragmatic DnD
// dispatches `onDrop` synchronously across the entire drop-target chain,
// so React state set inside the row's handler hasn't been re-rendered by
// the time the workspace DropZone's handler runs. This ref reflects the
// value from the last committed render, which is the row's id (set by
// the row's onDragEnter), and lets the DropZone bail out synchronously.
let lastCommittedActiveRowId: string | null = null;

export const RowDropTargetProvider = ({ children }: PropsWithChildren) => {
  const [activeRowId, setActiveRowId] = useState<string | null>(null);

  useEffect(() => {
    lastCommittedActiveRowId = activeRowId;
  }, [activeRowId]);

  const value = useMemo(() => ({ activeRowId, setActiveRowId }), [activeRowId]);

  return (
    <RowDropTargetContext.Provider value={value}>
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
 * Used by DropZone to suppress its overlay when a row handles the drop.
 */
export const useIsRowDropTargetActive = (): boolean => {
  const context = useContext(RowDropTargetContext);
  return context?.activeRowId !== null;
};

/**
 * Synchronous read of the active row id at the most recently committed
 * render. Use inside Pragmatic DnD callbacks where React state setters
 * scheduled earlier in the same dispatch chain haven't been applied yet.
 */
export const getLastCommittedActiveRowId = (): string | null =>
  lastCommittedActiveRowId;

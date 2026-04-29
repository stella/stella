// ============================================================================
// TABLE SELECTION
// ============================================================================

/** Cell coordinates in a table */
export type CellCoordinates = {
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
};

/** TableSelectionManager snapshot */
export type TableSelectionSnapshot = {
  /** Currently selected cell, or null if no selection */
  selectedCell: CellCoordinates | null;
};

// ============================================================================
// ERROR MANAGER
// ============================================================================

/** Error severity levels */
export type ErrorSeverity = "error" | "warning" | "info";

/** Error notification */
export type ErrorNotification = {
  id: string;
  message: string;
  severity: ErrorSeverity;
  details?: string;
  timestamp: number;
  dismissed?: boolean;
};

/** ErrorManager snapshot */
export type ErrorManagerSnapshot = {
  notifications: ErrorNotification[];
};

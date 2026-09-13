/**
 * How a table's columns are arranged, and where that arrangement is kept.
 *
 * The table stack reads the arrangement through this object rather than from
 * a saved view, so the host owns the storage: a matter keeps it in the view
 * it belongs to and saves it for everyone, while a page of public results
 * keeps it in the reader's own browser. Neither the table, the header menus
 * nor the column chooser knows which.
 */

/** The parts of an arrangement a change carries; the rest stay as they are. */
type TableColumnLayoutChange = {
  hidden?: readonly string[];
  order?: readonly string[];
  pinned?: readonly string[];
};

export type TableColumnLayout = {
  /** Column ids the reader hid. */
  hidden: readonly string[];
  /** Column ids in reading order; empty means the schema's own order. */
  order: readonly string[];
  /** Column ids kept in front of the order. */
  pinned: readonly string[];
  onChange: (change: TableColumnLayoutChange) => void;
};

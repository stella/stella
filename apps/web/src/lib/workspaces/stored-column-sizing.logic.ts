import type { TableViewRef } from "@/lib/workspaces/table-store.logic";

/** The widths a reader dragged a view's columns to, by column id. */
export type StoredColumnSizing = Readonly<Record<string, number>>;

type StoredColumnSizingReader = (
  ref: TableViewRef,
) => StoredColumnSizing | undefined;

// The table store's reader of its persisted widths. The store registers it as
// it is created, which the router does at startup; a loading view reads the
// widths through it without loading the store's module, which would bring the
// account storage and its analytics into the views drawn before the page.
const READER: { current: StoredColumnSizingReader | undefined } = {
  current: undefined,
};

/** Called by the table store once, when it is created. */
export const registerStoredColumnSizing = (
  read: StoredColumnSizingReader,
): void => {
  READER.current = read;
};

/**
 * The widths the table store holds for a view, read synchronously, so a
 * loading table lays its columns where the loaded one will. `undefined`
 * before the store exists (the server's paint) or when nothing was resized.
 */
export const storedColumnSizing = (
  ref: TableViewRef,
): StoredColumnSizing | undefined => READER.current?.(ref);

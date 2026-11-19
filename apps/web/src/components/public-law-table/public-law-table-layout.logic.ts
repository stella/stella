import * as v from "valibot";

import { TABLE_CONTENT_MODES } from "@stll/api-contract/public-law-table";
import type { TableContentMode } from "@stll/api-contract/public-law-table";

import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-column-sizing";

/**
 * How this browser draws a public-law results table on one surface (a
 * jurisdiction): which columns it hides, in what order it puts them, which it
 * keeps in front, how wide they are and how much of a prose cell it shows. A
 * table adds its own preferences beside these (the decision table its excerpt
 * length).
 *
 * Rules, not storage: the presentation cookie boundary owns persistence and
 * this module owns what a stored value means, so every rule here is testable
 * without a browser.
 */
export type PublicLawTableLayout = {
  hidden: readonly string[];
  /** Column ids in reading order; empty means the columns' own order. */
  order: readonly string[];
  /** Column ids kept in front of the order. */
  pinned: readonly string[];
  /** Widths the reader dragged, by column id; the column's own otherwise. */
  sizing: Readonly<Record<string, number>>;
  contentMode: TableContentMode;
};

/** Replay a table action against its latest stored arrangement. */
export type PublicLawTableLayoutUpdate<TLayout extends PublicLawTableLayout> = (
  latest: TLayout,
) => TLayout;

type ApplyPublicLawSizingChangeOptions = {
  previous: PublicLawTableLayout["sizing"];
  next: PublicLawTableLayout["sizing"];
  latest: PublicLawTableLayout["sizing"];
};

/** A controlled table publishes the full sizing map; retain only its edit. */
export const applyPublicLawSizingChange = ({
  previous,
  next,
  latest,
}: ApplyPublicLawSizingChangeOptions) => {
  const removed = new Set(
    Object.keys(previous).filter((column) => !(column in next)),
  );
  return {
    ...Object.fromEntries(
      Object.entries(latest).filter(([column]) => !removed.has(column)),
    ),
    ...Object.fromEntries(
      Object.entries(next).filter(
        ([column, width]) => previous[column] !== width,
      ),
    ),
  };
};

/** One empty sizing map, so an untouched layout keeps one identity. */
export const NO_COLUMN_SIZING: Readonly<Record<string, number>> = {};

/** Column identities and bounds come from each table's owning model. */
export const publicLawStoredLayoutEntries = (columnIds: readonly string[]) => {
  const list = v.pipe(
    v.array(v.picklist(columnIds)),
    v.maxLength(columnIds.length),
  );
  return {
    hidden: v.optional(list),
    order: v.optional(list),
    pinned: v.optional(list),
    sizing: v.optional(
      v.record(
        v.picklist(columnIds),
        v.pipe(
          v.number(),
          v.minValue(DEFAULT_TABLE_COLUMN_MIN_SIZE),
          v.maxValue(Number.MAX_SAFE_INTEGER),
        ),
      ),
    ),
    contentMode: v.optional(v.picklist(TABLE_CONTENT_MODES)),
  };
};

type StoredPublicLawLayout = v.InferOutput<
  v.ObjectSchema<ReturnType<typeof publicLawStoredLayoutEntries>, undefined>
>;

/** The shared half of a stored layout; the defaults for anything it omits. */
export const publicLawTableLayout = (
  stored: StoredPublicLawLayout,
  defaults: PublicLawTableLayout,
): PublicLawTableLayout => ({
  hidden: stored.hidden ?? defaults.hidden,
  order: stored.order ?? defaults.order,
  pinned: stored.pinned ?? defaults.pinned,
  sizing: stored.sizing ?? defaults.sizing,
  contentMode: stored.contentMode ?? defaults.contentMode,
});

/**
 * Every stored arrangement, read once.
 *
 * The table's state is handed to TanStack as controlled state, which it
 * compares by identity: a layout rebuilt during render is a different object
 * every time, so the table publishes state the component did not change, the
 * publish re-renders the component, and the render rebuilds the layout again.
 * Normalising at the storage read, and looking the surface up afterwards, is
 * what makes that loop impossible rather than merely unlikely.
 */
export const publicLawTableLayouts = <TStored, TLayout>(
  stored: Readonly<Record<string, TStored>>,
  read: (value: TStored) => TLayout,
): Record<string, TLayout> => {
  const layouts: Record<string, TLayout> = {};
  for (const [surface, value] of Object.entries(stored)) {
    layouts[surface] = read(value);
  }
  return layouts;
};

type LayoutForSurfaceOptions<TLayout> = {
  defaults: TLayout;
  layouts: Readonly<Record<string, TLayout>> | null;
  surface: string;
};

/**
 * The arrangement of one surface: the same object on every call, because the
 * table is given it on every render.
 */
export const layoutForSurface = <TLayout>({
  defaults,
  layouts,
  surface,
}: LayoutForSurfaceOptions<TLayout>): TLayout => layouts?.[surface] ?? defaults;

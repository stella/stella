import type { PendingTextKey } from "@/components/pending-text";
import type { InternalPropertyId } from "@/components/workspaces/internal-ids.logic";
import type { WorkspaceProperty } from "@/lib/types";

/*
 * The filesystem view's geometry: its columns, their grid template and the
 * row height. The loaded tree and its pending face both read them from here
 * (and the boxes' classes from `tree-view.pending.tsx`), so the face's
 * columns and rows are the tree's own.
 */

/** One tree row; the virtualizer's estimate and the face's row height. */
export const FILESYSTEM_ROW_HEIGHT_PX = 36;

export const FILESYSTEM_CREATED_BY_ID =
  "_created-by" satisfies InternalPropertyId;
export const FILESYSTEM_UPDATED_AT_ID =
  "_updated-at" satisfies InternalPropertyId;
export const FILESYSTEM_VERSION_ID = "_version" satisfies InternalPropertyId;
const FILESYSTEM_METADATA_IDS = [
  FILESYSTEM_CREATED_BY_ID,
  FILESYSTEM_UPDATED_AT_ID,
  FILESYSTEM_VERSION_ID,
] as const;

type FilesystemMetadataId = (typeof FILESYSTEM_METADATA_IDS)[number];

/** The message each metadata column's header shows. */
export const FILESYSTEM_METADATA_LABEL_IDS = {
  [FILESYSTEM_CREATED_BY_ID]: "common.author",
  [FILESYSTEM_UPDATED_AT_ID]: "common.lastUpdated",
  [FILESYSTEM_VERSION_ID]: "common.version",
} as const satisfies Record<FilesystemMetadataId, PendingTextKey>;

export type ExtraColumn =
  | { type: "property"; id: string; label: string; property: WorkspaceProperty }
  | {
      type: "metadata";
      id: FilesystemMetadataId;
      label: string;
    };

const isFilesystemMetadataId = (id: string): id is FilesystemMetadataId =>
  FILESYSTEM_METADATA_IDS.some((metadataId) => metadataId === id);

/**
 * The columns after Name: the metadata columns, then the matter's
 * properties, less the hidden ones and the file properties (the Name column
 * already shows the file).
 */
export const resolveExtraColumns = (
  hiddenProperties: readonly string[],
  properties: readonly WorkspaceProperty[],
  metadataLabels: Readonly<Record<string, string>>,
): ExtraColumn[] => {
  const propertyById = new Map(
    properties.map((property) => [property.id, property]),
  );
  const ids = [
    ...FILESYSTEM_METADATA_IDS,
    ...properties.map((p) => p.id),
  ].filter((id) => !hiddenProperties.includes(id));

  const cols: ExtraColumn[] = [];

  for (const id of ids) {
    if (isFilesystemMetadataId(id)) {
      cols.push({
        type: "metadata",
        id,
        label: metadataLabels[id] ?? id,
      });
    } else {
      const prop = propertyById.get(id);
      // Skip file-type properties — the Name column already
      // shows the filename, so a "Documents" column is redundant.
      if (prop && prop.content.type !== "file") {
        cols.push({
          type: "property",
          id: prop.id,
          label: prop.name,
          property: prop,
        });
      }
    }
  }

  return cols;
};

export const NAME_COL_ID = "__name__";
export const DEFAULT_EXTRA_WIDTH_PX = 128;
/** The narrowest a column gets, by a drag or by yielding to a narrow view. */
export const MIN_COLUMN_WIDTH_PX = 80;
/** The narrowest the Name column gets before the tree scrolls sideways. */
const NAME_MIN_WIDTH = "10rem";

/** The trailing actions track `buildGridTemplate` ends every template with. */
const ACTIONS_COL_RE = / 2rem$/u;

/**
 * The tree's grid: Name (a stored width, or a flexible track), each extra
 * column at its stored width or yielding from its default width down to the
 * minimum, then the row actions. A column nobody sized gives up room before
 * the tree scrolls sideways, so a docked pane beside the list narrows the
 * columns (their headers truncate) instead of cutting the last one off at
 * the scroll edge; only once every column is at its minimum does the tree
 * scroll. A width someone dragged a column to is kept as it is.
 */
export const buildGridTemplate = (
  extraColumns: readonly ExtraColumn[],
  widths: Readonly<Record<string, number>>,
): string => {
  const nameWidth = widths[NAME_COL_ID];
  const nameTrack =
    nameWidth !== undefined
      ? `${nameWidth}px`
      : `minmax(${NAME_MIN_WIDTH}, 1fr)`;
  const extraTracks = extraColumns
    .map((col) => {
      const stored = widths[col.id];
      return stored !== undefined
        ? `${stored}px`
        : `minmax(${MIN_COLUMN_WIDTH_PX}px, ${DEFAULT_EXTRA_WIDTH_PX}px)`;
    })
    .join(" ");
  return `${nameTrack}${extraTracks ? ` ${extraTracks}` : ""} 2rem`;
};

/**
 * A row's content area: every column but the actions, on the row's own
 * tracks, so its cells line up with the header's.
 */
export const filesystemRowContentStyle = (gridTemplate: string) =>
  ({
    gridColumn: "1 / -2",
    display: "grid",
    gridTemplateColumns: gridTemplate.replace(ACTIONS_COL_RE, ""),
    alignItems: "center",
    alignSelf: "stretch",
    columnGap: "1rem",
  }) as const;

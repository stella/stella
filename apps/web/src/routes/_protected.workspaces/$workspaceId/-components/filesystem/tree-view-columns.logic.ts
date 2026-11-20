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

/** The trailing actions track `buildGridTemplate` ends every template with. */
const ACTIONS_COL_RE = / 2rem$/u;

/**
 * The tree's grid: Name (a stored width, or a flexible track), each extra
 * column at its stored or default width, then the row actions.
 */
export const buildGridTemplate = (
  extraColumns: readonly ExtraColumn[],
  widths: Readonly<Record<string, number>>,
): string => {
  const nameWidth = widths[NAME_COL_ID];
  const nameTrack =
    nameWidth !== undefined ? `${nameWidth}px` : "minmax(20rem, 1fr)";
  const extraTracks = extraColumns
    .map((col) => `${widths[col.id] ?? DEFAULT_EXTRA_WIDTH_PX}px`)
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

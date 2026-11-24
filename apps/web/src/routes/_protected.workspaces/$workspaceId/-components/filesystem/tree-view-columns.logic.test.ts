import { describe, expect, test } from "bun:test";

import {
  buildGridTemplate,
  DEFAULT_EXTRA_WIDTH_PX,
  type ExtraColumn,
  FILESYSTEM_CREATED_BY_ID,
  FILESYSTEM_UPDATED_AT_ID,
  FILESYSTEM_VERSION_ID,
  MIN_COLUMN_WIDTH_PX,
  NAME_COL_ID,
} from "./tree-view-columns.logic";

const REM_PX = 16;
/** The grid's column gap (`gap-x-4`) and inline padding (`px-2`). */
const COLUMN_GAP_PX = 16;
const ROW_PADDING_PX = 16;

const lengthPx = (length: string): number => {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/u.exec(length.trim());
  if (match === null) {
    throw new Error(`not a fixed length: ${length}`);
  }
  const value = Number(match[1]);
  return match[2] === "rem" ? value * REM_PX : value;
};

/** Tracks as their narrowest and widest, in px; `null` grows without end. */
const tracksOf = (template: string) =>
  [...template.matchAll(/minmax\(([^,]+),([^)]+)\)|(\S+)/gu)].map((match) => {
    const [, min, max, fixed] = match;
    if (fixed !== undefined) {
      return { narrowest: lengthPx(fixed), widest: lengthPx(fixed) };
    }
    return {
      narrowest: lengthPx(min ?? ""),
      widest: max?.trim().endsWith("fr") ? null : lengthPx(max ?? ""),
    };
  });

const narrowest = (template: string) => {
  const tracks = tracksOf(template);
  return (
    tracks.reduce((sum, track) => sum + track.narrowest, 0) +
    COLUMN_GAP_PX * (tracks.length - 1) +
    ROW_PADDING_PX
  );
};

const METADATA_COLUMNS: ExtraColumn[] = [
  { type: "metadata", id: FILESYSTEM_CREATED_BY_ID, label: "Author" },
  { type: "metadata", id: FILESYSTEM_UPDATED_AT_ID, label: "Last updated" },
  { type: "metadata", id: FILESYSTEM_VERSION_ID, label: "Version" },
];

describe("buildGridTemplate", () => {
  test("a list with its default columns fits beside a docked pane without scrolling sideways", () => {
    // A 1280px window with the sidebar and the inspector at its default
    // 512px leaves the list about 512px. Every column nobody sized yields
    // down to its minimum before the tree scrolls.
    const template = buildGridTemplate(METADATA_COLUMNS, {});
    expect(narrowest(template)).toBeLessThanOrEqual(512);
  });

  test("a column nobody sized yields between the minimum and its default width", () => {
    const tracks = tracksOf(buildGridTemplate(METADATA_COLUMNS, {}));
    for (const track of tracks.slice(1, -1)) {
      expect(track).toEqual({
        narrowest: MIN_COLUMN_WIDTH_PX,
        widest: DEFAULT_EXTRA_WIDTH_PX,
      });
    }
    expect(tracks.at(0)?.widest).toBeNull();
  });

  test("a width someone dragged a column to is kept as it is", () => {
    const nameWidth = DEFAULT_EXTRA_WIDTH_PX * 3;
    const updatedWidth = DEFAULT_EXTRA_WIDTH_PX + MIN_COLUMN_WIDTH_PX;
    const tracks = tracksOf(
      buildGridTemplate(METADATA_COLUMNS, {
        [NAME_COL_ID]: nameWidth,
        [FILESYSTEM_UPDATED_AT_ID]: updatedWidth,
      }),
    );
    expect(tracks.at(0)).toEqual({ narrowest: nameWidth, widest: nameWidth });
    expect(tracks.at(2)).toEqual({
      narrowest: updatedWidth,
      widest: updatedWidth,
    });
  });
});

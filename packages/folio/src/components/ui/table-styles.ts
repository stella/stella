/**
 * Built-in table style presets (matching common Word styles).
 * Extracted from the original TableStyleGallery; only the type + data.
 */

import type { Style } from "../../core/types/document";

export type TableStylePreset = {
  id: string;
  name: string;
  tableBorders?: {
    top?: { style: string; size?: number; color?: { rgb: string } };
    bottom?: { style: string; size?: number; color?: { rgb: string } };
    left?: { style: string; size?: number; color?: { rgb: string } };
    right?: { style: string; size?: number; color?: { rgb: string } };
    insideH?: { style: string; size?: number; color?: { rgb: string } };
    insideV?: { style: string; size?: number; color?: { rgb: string } };
  };
  conditionals?: Record<
    string,
    {
      backgroundColor?: string;
      borders?: {
        top?: { style: string; size?: number; color?: { rgb: string } } | null;
        bottom?: {
          style: string;
          size?: number;
          color?: { rgb: string };
        } | null;
        left?: {
          style: string;
          size?: number;
          color?: { rgb: string };
        } | null;
        right?: {
          style: string;
          size?: number;
          color?: { rgb: string };
        } | null;
      };
      bold?: boolean;
      color?: string;
    }
  >;
  look?: {
    firstRow?: boolean;
    lastRow?: boolean;
    firstCol?: boolean;
    lastCol?: boolean;
    noHBand?: boolean;
    noVBand?: boolean;
  };
};

const border1 = (rgb: string) => ({
  style: "single" as const,
  size: 4,
  color: { rgb },
});

const BUILTIN_STYLES: TableStylePreset[] = [
  {
    id: "TableNormal",
    name: "Normal Table",
    look: { firstRow: false, lastRow: false, noHBand: true, noVBand: true },
  },
  {
    id: "TableGrid",
    name: "Table Grid",
    tableBorders: {
      top: border1("000000"),
      bottom: border1("000000"),
      left: border1("000000"),
      right: border1("000000"),
      insideH: border1("000000"),
      insideV: border1("000000"),
    },
    look: { firstRow: false, lastRow: false, noHBand: true, noVBand: true },
  },
  {
    id: "TableGridLight",
    name: "Grid Table Light",
    tableBorders: {
      top: border1("BFBFBF"),
      bottom: border1("BFBFBF"),
      left: border1("BFBFBF"),
      right: border1("BFBFBF"),
      insideH: border1("BFBFBF"),
      insideV: border1("BFBFBF"),
    },
    look: { firstRow: true, lastRow: false, noHBand: true, noVBand: true },
    conditionals: {
      firstRow: { bold: true, borders: { bottom: border1("000000") } },
    },
  },
  {
    id: "PlainTable1",
    name: "Plain Table 1",
    tableBorders: {
      top: border1("BFBFBF"),
      bottom: border1("BFBFBF"),
      insideH: border1("BFBFBF"),
    },
    look: { firstRow: true, lastRow: false, noHBand: true, noVBand: true },
    conditionals: { firstRow: { bold: true } },
  },
  {
    id: "PlainTable2",
    name: "Plain Table 2",
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, borders: { bottom: border1("7F7F7F") } },
      band1Horz: { backgroundColor: "#F2F2F2" },
    },
  },
  {
    id: "PlainTable3",
    name: "Plain Table 3",
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#A5A5A5" },
      band1Horz: { backgroundColor: "#E7E7E7" },
    },
  },
  {
    id: "PlainTable4",
    name: "Plain Table 4",
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#000000" },
      band1Horz: { backgroundColor: "#F2F2F2" },
    },
  },
  {
    id: "GridTable1Light-Accent1",
    name: "Grid Table 1 Light",
    tableBorders: {
      top: border1("B4C6E7"),
      bottom: border1("B4C6E7"),
      left: border1("B4C6E7"),
      right: border1("B4C6E7"),
      insideH: border1("B4C6E7"),
      insideV: border1("B4C6E7"),
    },
    look: { firstRow: true, lastRow: false, noHBand: true, noVBand: true },
    conditionals: {
      firstRow: { bold: true, borders: { bottom: border1("4472C4") } },
    },
  },
  {
    id: "GridTable4-Accent1",
    name: "Grid Table 4 Accent 1",
    tableBorders: {
      top: border1("4472C4"),
      bottom: border1("4472C4"),
      left: border1("4472C4"),
      right: border1("4472C4"),
      insideH: border1("4472C4"),
      insideV: border1("4472C4"),
    },
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#4472C4" },
      band1Horz: { backgroundColor: "#D6E4F0" },
    },
  },
  {
    id: "GridTable5Dark-Accent1",
    name: "Grid Table 5 Dark",
    tableBorders: {
      top: border1("FFFFFF"),
      bottom: border1("FFFFFF"),
      left: border1("FFFFFF"),
      right: border1("FFFFFF"),
      insideH: border1("FFFFFF"),
      insideV: border1("FFFFFF"),
    },
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#4472C4" },
      band1Horz: { backgroundColor: "#D6E4F0" },
      band2Horz: { backgroundColor: "#B4C6E7" },
    },
  },
  {
    id: "ListTable3-Accent2",
    name: "List Table 3 Accent 2",
    tableBorders: {
      top: border1("ED7D31"),
      bottom: border1("ED7D31"),
    },
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#ED7D31" },
      band1Horz: { backgroundColor: "#FBE4D5" },
    },
  },
  {
    id: "ListTable4-Accent3",
    name: "List Table 4 Accent 3",
    tableBorders: {
      top: border1("A5A5A5"),
      bottom: border1("A5A5A5"),
      insideH: border1("A5A5A5"),
    },
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#A5A5A5" },
      band1Horz: { backgroundColor: "#EDEDED" },
    },
  },
  {
    id: "GridTable4-Accent5",
    name: "Grid Table 4 Accent 5",
    tableBorders: {
      top: border1("5B9BD5"),
      bottom: border1("5B9BD5"),
      left: border1("5B9BD5"),
      right: border1("5B9BD5"),
      insideH: border1("5B9BD5"),
      insideV: border1("5B9BD5"),
    },
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#5B9BD5" },
      band1Horz: { backgroundColor: "#DEEAF6" },
    },
  },
  {
    id: "GridTable4-Accent6",
    name: "Grid Table 4 Accent 6",
    tableBorders: {
      top: border1("70AD47"),
      bottom: border1("70AD47"),
      left: border1("70AD47"),
      right: border1("70AD47"),
      insideH: border1("70AD47"),
      insideV: border1("70AD47"),
    },
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
    conditionals: {
      firstRow: { bold: true, color: "#FFFFFF", backgroundColor: "#70AD47" },
      band1Horz: { backgroundColor: "#E2EFDA" },
    },
  },
];

/** Get a built-in style preset by ID. */
export const getBuiltinTableStyle = (
  styleId: string,
): TableStylePreset | undefined => BUILTIN_STYLES.find((s) => s.id === styleId);

/** Convert a document Style (from styles.xml) to a TableStylePreset. */
export const documentStyleToPreset = (style: Style): TableStylePreset => {
  const preset: TableStylePreset = {
    id: style.styleId,
    name: style.name ?? style.styleId,
    look: { firstRow: true, lastRow: false, noHBand: false, noVBand: true },
  };

  if (style.tblPr?.borders) {
    const b = style.tblPr.borders;
    preset.tableBorders = {};
    for (const side of [
      "top",
      "bottom",
      "left",
      "right",
      "insideH",
      "insideV",
    ] as const) {
      const bs = b[side];
      if (bs) {
        preset.tableBorders[side] = {
          style: bs.style,
          ...(bs.size !== undefined ? { size: bs.size } : {}),
          ...(bs.color?.rgb ? { color: { rgb: bs.color.rgb } } : {}),
        };
      }
    }
  }

  if (style.tblStylePr) {
    preset.conditionals = {};
    for (const cond of style.tblStylePr) {
      const entry: NonNullable<TableStylePreset["conditionals"]>[string] = {};
      if (cond.tcPr?.shading?.fill) {
        entry.backgroundColor = `#${cond.tcPr.shading.fill}`;
      }
      if (cond.tcPr?.borders) {
        entry.borders = {};
        for (const side of ["top", "bottom", "left", "right"] as const) {
          const bs = cond.tcPr.borders[side];
          if (bs) {
            entry.borders[side] = {
              style: bs.style,
              ...(bs.size !== undefined ? { size: bs.size } : {}),
              ...(bs.color?.rgb ? { color: { rgb: bs.color.rgb } } : {}),
            };
          }
        }
      }
      if (cond.rPr?.bold) {
        entry.bold = true;
      }
      if (cond.rPr?.color?.rgb) {
        entry.color = `#${cond.rPr.color.rgb}`;
      }
      preset.conditionals[cond.type] = entry;
    }
  }

  return preset;
};

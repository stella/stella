import { panic } from "better-result";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

export type VisualTreemapTree =
  | {
      readonly type: "group";
      readonly id: string;
      readonly label: string;
      readonly tier?: CourtTierLabel;
      readonly children: readonly VisualTreemapTree[];
    }
  | {
      readonly type: "bucket";
      readonly id: string;
      readonly label: string;
      readonly count: number;
      readonly citationSum: number | null;
      readonly treatment: number | null;
      readonly tier: CourtTierLabel;
      readonly court: string;
      readonly year: number;
    };

export type VisualColorMode = "citations" | "treatment" | "category";

export type VisualTreemapColor =
  | {
      mode: "citations" | "treatment";
      legend: boolean;
      field?: keyof Extract<VisualTreemapTree, { type: "bucket" }>;
    }
  | {
      mode: "category";
      field: keyof Extract<VisualTreemapTree, { type: "bucket" }>;
      legend: boolean;
    };

type TreemapRow = {
  node: VisualTreemapTree;
  count: number;
  citationSum: number | null;
  treatment: number | null;
};

// Each screen tiles immediate children; a group becomes a leaf in this
// projection, preserving its aggregate area until the user zooms into it.
export const createTreemapModel = (tree: VisualTreemapTree) => {
  const rows = new Map<string, TreemapRow>();
  const parents = new Map<string, VisualTreemapTree>();
  const visit = (node: VisualTreemapTree, depth: number): TreemapRow => {
    if (depth > 32 || rows.size >= 1024 || rows.has(node.id)) {
      panic(
        "Treemap requires unique identities and a bounded acyclic hierarchy",
      );
    }
    const row: TreemapRow = { node, count: 0, citationSum: 0, treatment: null };
    rows.set(node.id, row);
    switch (node.type) {
      case "bucket": {
        if (
          !Number.isFinite(node.count) ||
          node.count < 0 ||
          (node.citationSum !== null &&
            (!Number.isFinite(node.citationSum) || node.citationSum < 0)) ||
          (node.treatment !== null && !Number.isFinite(node.treatment))
        ) {
          panic(
            "Treemap values must be finite; count and citationSum must be nonnegative",
          );
        }
        row.count = node.count;
        row.citationSum = node.citationSum;
        row.treatment = node.treatment;
        return row;
      }
      case "group": {
        row.treatment = 0;
        for (const child of node.children) {
          parents.set(child.id, node);
          const values = visit(child, depth + 1);
          row.count += values.count;
          row.citationSum =
            row.citationSum === null || values.citationSum === null
              ? null
              : row.citationSum + values.citationSum;
          row.treatment =
            row.treatment === null || values.treatment === null
              ? null
              : row.treatment + values.treatment;
        }
        if (
          !Number.isFinite(row.count) ||
          (row.citationSum !== null && !Number.isFinite(row.citationSum)) ||
          (row.treatment !== null && !Number.isFinite(row.treatment))
        ) {
          panic("Treemap aggregate values must be finite");
        }
        return row;
      }
      default: {
        node satisfies never;
        return panic("Unhandled treemap node type");
      }
    }
  };
  visit(tree, 0);
  let root = tree;
  const getRow = (id: string) => {
    const row = rows.get(id);
    if (!row) {
      panic("Treemap selected an unknown identity");
    }
    return row;
  };
  const visible = () =>
    (root.type === "group" ? root.children : [root]).map(({ id }) =>
      getRow(id),
    );
  return {
    root: () => root,
    visible,
    nodes: () => Array.from(rows.values(), ({ node }) => node),
    select: (id: string) => {
      const row = visible().find(({ node }) => node.id === id);
      if (!row) {
        panic("Treemap selection must belong to the visible level");
      }
      if (
        row.node.type === "group" &&
        row.node.children.length > 0 &&
        row.count > 0
      ) {
        root = row.node;
      }
      return row.node;
    },
    back: () => {
      const parent = parents.get(root.id);
      if (!parent) {
        return false;
      }
      root = parent;
      return true;
    },
  };
};

export const treemapColorDomain = (
  rows: readonly TreemapRow[],
  mode: Exclude<VisualColorMode, "category">,
) => {
  switch (mode) {
    case "citations":
      return [
        0,
        Math.max(0, ...rows.map(({ citationSum }) => citationSum ?? 0)),
      ] as const;
    case "treatment": {
      const extent = Math.max(
        0,
        ...rows.map(({ treatment }) => Math.abs(treatment ?? 0)),
      );
      return extent === 0 ? ([0, 0] as const) : ([-extent, extent] as const);
    }
    default: {
      mode satisfies never;
      return panic("Unhandled treemap color mode");
    }
  }
};

export const treemapCategoryValue = (
  node: VisualTreemapTree,
  field: Extract<VisualTreemapColor, { mode: "category" }>["field"],
) => {
  if (node.type === "bucket") {
    const value = node[field];
    return value === null ? null : String(value);
  }
  switch (field) {
    case "id":
    case "label":
    case "type":
    case "tier": {
      const value = node[field];
      return value === undefined ? null : String(value);
    }
    case "count":
    case "citationSum":
    case "treatment":
    case "court":
    case "year":
      return null;
    default: {
      field satisfies never;
      return panic("Unhandled treemap category field");
    }
  }
};

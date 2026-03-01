import type { ViewConfig } from "@/api/db/schema-validators";

/**
 * Layouts that every workspace must have exactly one of.
 * These views are created automatically on workspace creation
 * and cannot be deleted.
 */
export const REQUIRED_VIEW_LAYOUTS = [
  "overview",
  "table",
  "filesystem",
] as const;

export type RequiredViewLayout = (typeof REQUIRED_VIEW_LAYOUTS)[number];

/** Set variant for O(1) lookups that accept any string. */
export const REQUIRED_VIEW_LAYOUT_SET: ReadonlySet<string> = new Set(
  REQUIRED_VIEW_LAYOUTS,
);

type DefaultView = {
  name: string;
  layout: RequiredViewLayout;
  config: ViewConfig;
  position: number;
};

const EMPTY_VIEW_CONFIG: ViewConfig = {
  filters: [],
  sorts: [],
  visibleProperties: [],
  columnSizing: {},
  columnOrder: [],
};

/**
 * Default views created for every new workspace.
 * Order matches the position field.
 */
export const DEFAULT_VIEWS: readonly DefaultView[] = [
  {
    name: "Overview",
    layout: "overview",
    config: EMPTY_VIEW_CONFIG,
    position: 0,
  },
  {
    name: "Table",
    layout: "table",
    config: EMPTY_VIEW_CONFIG,
    position: 1,
  },
  {
    name: "Files",
    layout: "filesystem",
    config: EMPTY_VIEW_CONFIG,
    position: 2,
  },
] as const;

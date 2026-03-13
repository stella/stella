import type {
  ViewLayout,
  ViewLayoutType,
} from "@/api/handlers/registry/actors/views/schema";

/**
 * Layouts that every workspace must have exactly one of.
 * These views are created automatically on workspace creation
 * and cannot be deleted.
 */
export const REQUIRED_VIEW_LAYOUTS: ViewLayoutType[] = [
  "overview",
  "table",
  "filesystem",
];

type DefaultView = {
  name: string;
  layout: ViewLayout;
  position: number;
};

const emptyLayout = (
  type: "overview" | "table" | "filesystem" | "kanban",
): ViewLayout => {
  const base = {
    filters: [] as ViewLayout["filters"],
    sorts: [] as ViewLayout["sorts"],
    hiddenProperties: [] as string[],
  };

  if (type === "table") {
    return {
      type,
      ...base,
      columnOrder: [],
      columnPinning: [],
    };
  }

  return { type, ...base };
};

/**
 * Default views created for every new workspace.
 * Order matches the position field.
 */
export const DEFAULT_VIEWS: readonly DefaultView[] = [
  {
    name: "Overview",
    layout: emptyLayout("overview"),
    position: 0,
  },
  {
    name: "Table",
    layout: emptyLayout("table"),
    position: 1,
  },
  {
    name: "Files",
    layout: emptyLayout("filesystem"),
    position: 2,
  },
];

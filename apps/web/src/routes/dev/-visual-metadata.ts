export type VisualLayout =
  | "plain"
  | "control-sizes"
  | "inspector-pane"
  | "workspace-table";

type VisualEntry = {
  layout: VisualLayout;
  label: string;
};

// Browser tests share the fixture census without importing the app graph.
export const visualRegistry = {
  autocomplete: { label: "Autocomplete", layout: "plain" },
  ui: { label: "UI components", layout: "plain" },
  "control-sizes": { label: "Control sizes", layout: "control-sizes" },
  "inspector-pane": { label: "Inspector pane", layout: "inspector-pane" },
  "shell-pending": { label: "Shell pending", layout: "plain" },
  "workspace-table": { label: "Workspace table", layout: "workspace-table" },
} as const satisfies Record<string, VisualEntry>;

export type VisualName = keyof typeof visualRegistry;

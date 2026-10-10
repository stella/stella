export type VisualLayout =
  | "plain"
  | "control-sizes"
  | "inspector-pane"
  | "provision-header"
  | "workspace-table";

type VisualEntry = {
  layout: VisualLayout;
  label: string;
};

export const playbookEditorFixtures = {
  rejected: "00000000-0000-4000-8000-000000000601",
  editing: "00000000-0000-4000-8000-000000000602",
  parked: "00000000-0000-4000-8000-000000000603",
} as const;

export const playbookEditorStates = Object.keys(playbookEditorFixtures);

// Browser tests share the fixture census without importing the app graph.
export const visualRegistry = {
  autocomplete: { label: "Autocomplete", layout: "plain" },
  ui: { label: "UI components", layout: "plain" },
  "control-sizes": { label: "Control sizes", layout: "control-sizes" },
  "inspector-pane": { label: "Inspector pane", layout: "inspector-pane" },
  "playbook-editor": { label: "Playbook editor lifecycle", layout: "plain" },
  "provision-header": { label: "Provision header", layout: "provision-header" },
  "shell-pending": { label: "Shell pending", layout: "plain" },
  "workspace-table": { label: "Workspace table", layout: "workspace-table" },
} as const satisfies Record<string, VisualEntry>;

export type VisualName = keyof typeof visualRegistry;

import { CHAT_ANSWER_EDIT_STATES } from "@stll/api-contract/chat-message-revisions";

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

export const answerEditStates = CHAT_ANSWER_EDIT_STATES;

export const playbookEditorStates = Object.keys(playbookEditorFixtures);

/** Composer states with a reference chip, each in a 300px-wide composer,
 * keyed to the composer variant they render. */
export const composerReferenceVariants = {
  "compact-long": "compact",
  "large-long": "large",
  "compact-short": "compact",
  "compact-token": "compact",
} as const;

export const composerReferenceStates = Object.keys(composerReferenceVariants);

// Browser tests share the fixture census without importing the app graph.
export const visualRegistry = {
  "task-metadata": { label: "Task metadata alignment", layout: "plain" },
  "column-composer": { label: "Column composer alignment", layout: "plain" },
  "handoff-confirmation": {
    label: "Connector sign-in confirmation",
    layout: "plain",
  },
  "table-chart": { label: "Chat table chart", layout: "plain" },
  "oauth-consent": { label: "OAuth consent", layout: "plain" },
  "page-crop": { label: "PDF page crop", layout: "plain" },
  "upload-rejections": { label: "Upload rejection reasons", layout: "plain" },
  "chat-long-paste": { label: "Chat long paste", layout: "plain" },
  "chat-composer-reference": {
    label: "Chat composer references",
    layout: "plain",
  },
  "chat-status": { label: "Chat status motion", layout: "plain" },
  "chat-continuation-error": {
    label: "Chat continuation recovery",
    layout: "plain",
  },
  "chat-citations": { label: "Chat case-law citations", layout: "plain" },
  "chat-statute-citations": {
    label: "Chat statute citations",
    layout: "plain",
  },
  "chat-link-icons": { label: "Chat link icons", layout: "plain" },
  "hungarian-decision": { label: "Hungarian decision", layout: "plain" },
  "reader-answers": { label: "Reader anchored answers", layout: "plain" },
  "reader-selection": { label: "Reader selection toolbar", layout: "plain" },
  "answer-edit": { label: "Chat answer edits", layout: "plain" },
  autocomplete: { label: "Autocomplete", layout: "plain" },
  ui: { label: "UI components", layout: "plain" },
  "control-sizes": { label: "Control sizes", layout: "control-sizes" },
  "inspector-pane": { label: "Inspector pane", layout: "inspector-pane" },
  "playbook-editor": { label: "Playbook editor lifecycle", layout: "plain" },
  "provision-header": { label: "Provision header", layout: "provision-header" },
  "shell-pending": { label: "Shell pending", layout: "plain" },
  "workspace-table": { label: "Workspace table", layout: "workspace-table" },
  "public-law-toolbar": { label: "Public law toolbar", layout: "plain" },
  "chat-history-decision": { label: "Chat history decision", layout: "plain" },
} as const satisfies Record<string, VisualEntry>;

export type VisualName = keyof typeof visualRegistry;

import { create } from "zustand";

import type { DirectiveRange } from "@stll/folio";

import type { EditableField } from "@/routes/_protected.knowledge/-components/template-wizard";

// The Studio's editable manifest data + live document selection. Lives in a
// module-level store (not the inspector tab payload, which must be
// structured-cloneable) so the full-width Folio page and the Fields/Clauses/
// History tab — rendered in the global inspector, a separate React tree — share
// one source of truth. Only one template is authored at a time.

export type StudioField = EditableField & { aiPrompt: string | undefined };
export type NameExpr = { name: string; expression: string };

export const defaultStudioField = (path: string): StudioField => ({
  path,
  kind: "string",
  label: "",
  inputType: "text",
  required: false,
  options: [],
  aiPrompt: undefined,
});

type TemplateStudioSession = {
  templateId: string;
  fields: StudioField[];
  conditions: NameExpr[];
  computed: NameExpr[];
};

/** What the model proposes for a single field's configuration. */
export type SuggestedFieldConfig = {
  label?: string | undefined;
  inputType?: StudioField["inputType"] | undefined;
  aiPrompt?: string | undefined;
  exampleValue?: string | undefined;
};

/** Document actions the page owns; the inspector tab renders the buttons. */
export type StudioActions = {
  toggleDirectives: () => void;
  insertField: () => void;
  insertCondition: () => void;
  insertLoop: () => void;
  insertClause: () => void;
  /** Insert a `{{@clause:Name}}` slot bound to a linked clause's slot name. */
  insertClauseSlot: (slotName: string) => void;
  makeField: () => void;
  save: () => void;
  /** Ask the model to propose label/type/example for one field. */
  suggestFieldConfig: (path: string) => Promise<SuggestedFieldConfig | null>;
  /** Rewrite {{oldPath}} markers in the document and rename the field.
   *  Returns false when the new path is invalid or already taken. */
  renameFieldPath: (oldPath: string, newPath: string) => boolean;
  /** Move the document caret to the next/previous field marker. */
  focusAdjacentField: (direction: 1 | -1) => void;
  /** Move the document caret into the first marker of the given field. */
  focusField: (path: string) => void;
};

/** Page-owned UI state the inspector's action row reflects. */
export type StudioUiState = {
  metaLabel: string;
  showDirectives: boolean;
  hasSelection: boolean;
  isSaving: boolean;
};

const DEFAULT_UI: StudioUiState = {
  metaLabel: "",
  showDirectives: true,
  hasSelection: false,
  isSaving: false,
};

type TemplateStudioState = {
  /** Null until a template page mounts and seeds the session. */
  templateId: string | null;
  fields: StudioField[];
  conditions: NameExpr[];
  computed: NameExpr[];
  /** The directive the document caret currently sits in, or null. */
  selected: DirectiveRange | null;
  /** Unsaved manifest or document edits since the last load/save. */
  isDirty: boolean;
  actions: StudioActions | null;
  ui: StudioUiState;
  setActions: (actions: StudioActions | null) => void;
  patchUi: (patch: Partial<StudioUiState>) => void;
  init: (session: TemplateStudioSession) => void;
  /** Clear the session on page unmount, but only if it still owns it. */
  reset: (templateId: string) => void;
  upsertField: (path: string, patch: Partial<StudioField>) => void;
  renameField: (oldPath: string, newPath: string) => void;
  setConditions: (conditions: NameExpr[]) => void;
  setComputed: (computed: NameExpr[]) => void;
  setSelected: (selected: DirectiveRange | null) => void;
  markDirty: () => void;
  markSaved: () => void;
};

export const useTemplateStudioStore = create<TemplateStudioState>((set) => ({
  templateId: null,
  fields: [],
  conditions: [],
  computed: [],
  selected: null,
  isDirty: false,
  actions: null,
  ui: DEFAULT_UI,
  setActions: (actions) => set({ actions }),
  patchUi: (patch) => set((state) => ({ ui: { ...state.ui, ...patch } })),
  init: (session) =>
    set({
      templateId: session.templateId,
      fields: session.fields,
      conditions: session.conditions,
      computed: session.computed,
      selected: null,
      isDirty: false,
    }),
  reset: (templateId) =>
    set((state) =>
      state.templateId === templateId
        ? {
            templateId: null,
            fields: [],
            conditions: [],
            computed: [],
            selected: null,
            isDirty: false,
            actions: null,
            ui: DEFAULT_UI,
          }
        : state,
    ),
  upsertField: (path, patch) =>
    set((state) => {
      const exists = state.fields.some((f) => f.path === path);
      const fields = exists
        ? state.fields.map((f) => (f.path === path ? { ...f, ...patch } : f))
        : [...state.fields, { ...defaultStudioField(path), ...patch }];
      return { fields, isDirty: true };
    }),
  renameField: (oldPath, newPath) =>
    set((state) => ({
      fields: state.fields.map((f) =>
        f.path === oldPath ? { ...f, path: newPath } : f,
      ),
      isDirty: true,
    })),
  setConditions: (conditions) => set({ conditions, isDirty: true }),
  setComputed: (computed) => set({ computed, isDirty: true }),
  setSelected: (selected) => set({ selected }),
  markDirty: () => set({ isDirty: true }),
  markSaved: () => set({ isDirty: false }),
}));

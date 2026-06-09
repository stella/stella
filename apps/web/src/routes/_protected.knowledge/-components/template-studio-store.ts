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
  init: (session: TemplateStudioSession) => void;
  /** Clear the session on page unmount, but only if it still owns it. */
  reset: (templateId: string) => void;
  upsertField: (path: string, patch: Partial<StudioField>) => void;
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
  setConditions: (conditions) => set({ conditions, isDirty: true }),
  setComputed: (computed) => set({ computed, isDirty: true }),
  setSelected: (selected) => set({ selected }),
  markDirty: () => set({ isDirty: true }),
  markSaved: () => set({ isDirty: false }),
}));

import { create } from "zustand";

import type { TemplateRecipeDefinition } from "@stll/api/types";
import type { DirectiveRange, TemplatePreviewValue } from "@stll/folio";

import type { ReplacementSpec } from "@/routes/_protected.knowledge/-components/template-studio-suggestions";
import type { EditableField } from "@/routes/_protected.knowledge/-components/template-wizard";

// The Studio's editable manifest data + live document selection. Lives in a
// module-level store (not the inspector tab payload, which must be
// structured-cloneable) so the full-width Folio page and the Fields/Clauses/
// History tab — rendered in the global inspector, a separate React tree — share
// one source of truth. Only one template is authored at a time.

export type StudioField = EditableField & {
  aiPrompt: string | undefined;
  /** Person fills a stub; AI rewords it per occurrence to fit the context. */
  aiAdapt: boolean;
};
export type NameExpr = { name: string; expression: string };

export const defaultStudioField = (path: string): StudioField => ({
  path,
  kind: "string",
  label: "",
  inputType: "text",
  required: false,
  options: [],
  aiPrompt: undefined,
  aiAdapt: false,
});

type TemplateStudioSession = {
  templateId: string;
  fields: StudioField[];
  conditions: NameExpr[];
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
  /** Rewrite the selected `{{#if …}}` / `{{#elseif …}}` opener with a new
   *  expression. Returns false when nothing suitable is selected or the
   *  expression is invalid. */
  rewriteConditionExpr: (next: string) => boolean;
  /** Return to the template overview: move the document caret just past the
   *  selected marker (so selection sync doesn't immediately re-derive the
   *  same face) and clear the selection. */
  deselect: () => void;
  /** Move the document caret to the next/previous field marker. */
  focusAdjacentField: (direction: 1 | -1) => void;
  /** Move the document caret into the first marker of the given field. */
  focusField: (path: string) => void;
  /** Move the document caret to an exact document position. */
  focusPosition: (pos: number) => void;
  /** Live fill preview in the document: path → value (plain text, or
   *  formatted spans for lookup renderings), or null to clear. */
  setFillPreview: (values: Record<string, TemplatePreviewValue> | null) => void;
  /** Replace the selection (or insert at the caret) with an existing field's
   *  marker; replacing text flips the field to AI-adapted wording. */
  insertExistingField: (path: string) => void;
  /** Insert a saved recipe at the caret: loop recipes add the `{{#each}}`
   *  block with one marker paragraph per field, plain recipes add the
   *  markers inline; the pre-configured fields register in the session
   *  (existing paths are kept and the recipe's get a `_2` suffix). */
  insertRecipe: (definition: TemplateRecipeDefinition) => void;
  /** Make the field repeat per loop item (wrap its marker's containing
   *  paragraph in `{{#each path}}` / `{{/each}}` and re-path the field to
   *  the loop-item convention, `path` → `path.value`), or undo it (remove
   *  the enclosing each markers and re-path back to the loop's name).
   *  Returns false when the document could not be rewritten. */
  setFieldRepeatable: (path: string, repeatable: boolean) => boolean;
};

/** A bilingual-mirror proposal the page queues for the chat surface — the
 *  Studio's only AISuggestion decoration writer — to place in-document as
 *  an accept/reject suggestion. */
export type MirrorSuggestionRequest = {
  spec: ReplacementSpec;
  /** Runs once when the placed suggestion is accepted. */
  onAccepted?: (() => void) | undefined;
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

export type OutlineNode =
  | { type: "field"; path: string; from: number }
  | { type: "clause"; name: string; from: number }
  | {
      type: "group";
      kind: "if" | "elseif" | "else" | "each";
      expr: string;
      from: number;
      children: OutlineNode[];
    };

type TemplateStudioState = {
  /** Null until a template page mounts and seeds the session. */
  templateId: string | null;
  fields: StudioField[];
  conditions: NameExpr[];
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
  /** Document structure tree, rebuilt by the editor on every scan. */
  outline: OutlineNode[];
  setOutline: (outline: OutlineNode[]) => void;
  setSelected: (selected: DirectiveRange | null) => void;
  markDirty: () => void;
  markSaved: () => void;
  /** Bilingual-mirror proposals waiting for the chat surface to place. */
  pendingMirrorRequests: MirrorSuggestionRequest[];
  enqueueMirrorRequests: (requests: MirrorSuggestionRequest[]) => void;
  clearMirrorRequests: () => void;
};

export const useTemplateStudioStore = create<TemplateStudioState>((set) => ({
  templateId: null,
  fields: [],
  conditions: [],
  outline: [],
  setOutline: (outline) => set({ outline }),
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
      selected: null,
      isDirty: false,
      pendingMirrorRequests: [],
    }),
  reset: (templateId) =>
    set((state) =>
      state.templateId === templateId
        ? {
            templateId: null,
            fields: [],
            conditions: [],
            selected: null,
            isDirty: false,
            actions: null,
            ui: DEFAULT_UI,
            pendingMirrorRequests: [],
          }
        : state,
    ),
  pendingMirrorRequests: [],
  enqueueMirrorRequests: (requests) =>
    set((state) => ({
      pendingMirrorRequests: [...state.pendingMirrorRequests, ...requests],
    })),
  clearMirrorRequests: () => set({ pendingMirrorRequests: [] }),
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
  setSelected: (selected) => set({ selected }),
  markDirty: () => set({ isDirty: true }),
  markSaved: () => set({ isDirty: false }),
}));

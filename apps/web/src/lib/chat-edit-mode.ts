import { panic } from "better-result";

/**
 * Frontend mirror of `CHAT_EDIT_APPLY_MODE` / `DOCX_EDIT_REPRESENTATION` in
 * `apps/api/src/handlers/chat/chat-schema.ts`. Redefined locally (not
 * imported across the apps/api - apps/web boundary) the same way
 * `APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME` is redefined in
 * `-queries.ts` -- these are plain string literals with no shared runtime
 * logic, so a cross-package value import would only pull backend code into
 * the web bundle for no benefit.
 */
export const CHAT_EDIT_APPLY_MODE = {
  manual: "manual",
  auto: "auto",
} as const;
export type ChatEditApplyMode =
  (typeof CHAT_EDIT_APPLY_MODE)[keyof typeof CHAT_EDIT_APPLY_MODE];

export const DOCX_EDIT_REPRESENTATION = {
  trackedChanges: "tracked-changes",
  direct: "direct",
} as const;
export type DocxEditRepresentation =
  (typeof DOCX_EDIT_REPRESENTATION)[keyof typeof DOCX_EDIT_REPRESENTATION];

/**
 * The three selectable options in the composer's edit-mode dropdown. A
 * discriminated union (not two independent enums) because
 * `docxEditRepresentation` only means anything in "auto" mode -- manual
 * review picks its representation per-suggestion at accept time, so
 * "manual" carries no representation field at all.
 */
export type ChatEditModeSelection =
  | {
      editApplyMode: typeof CHAT_EDIT_APPLY_MODE.auto;
      docxEditRepresentation: typeof DOCX_EDIT_REPRESENTATION.trackedChanges;
    }
  | {
      editApplyMode: typeof CHAT_EDIT_APPLY_MODE.auto;
      docxEditRepresentation: typeof DOCX_EDIT_REPRESENTATION.direct;
    }
  | { editApplyMode: typeof CHAT_EDIT_APPLY_MODE.manual };

/** Stable ids for the three dropdown rows / persisted preference value. */
export const CHAT_EDIT_MODE_OPTION_ID = {
  autoTrackedChanges: "auto-tracked-changes",
  autoDirect: "auto-direct",
  manual: "manual",
} as const;
export type ChatEditModeOptionId =
  (typeof CHAT_EDIT_MODE_OPTION_ID)[keyof typeof CHAT_EDIT_MODE_OPTION_ID];

export const CHAT_EDIT_MODE_OPTION_IDS = [
  CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges,
  CHAT_EDIT_MODE_OPTION_ID.autoDirect,
  CHAT_EDIT_MODE_OPTION_ID.manual,
] as const satisfies readonly ChatEditModeOptionId[];

/** Matches `DEFAULT_CHAT_EDIT_APPLY_MODE` ("auto") /
 *  `DEFAULT_DOCX_EDIT_REPRESENTATION` ("tracked-changes") in chat-schema.ts. */
export const DEFAULT_CHAT_EDIT_MODE_OPTION_ID: ChatEditModeOptionId =
  CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges;

export const isChatEditModeOptionId = (
  value: unknown,
): value is ChatEditModeOptionId =>
  value === CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges ||
  value === CHAT_EDIT_MODE_OPTION_ID.autoDirect ||
  value === CHAT_EDIT_MODE_OPTION_ID.manual;

export const chatEditModeSelectionForOptionId = (
  optionId: ChatEditModeOptionId,
): ChatEditModeSelection => {
  switch (optionId) {
    case CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges:
      return {
        editApplyMode: CHAT_EDIT_APPLY_MODE.auto,
        docxEditRepresentation: DOCX_EDIT_REPRESENTATION.trackedChanges,
      };
    case CHAT_EDIT_MODE_OPTION_ID.autoDirect:
      return {
        editApplyMode: CHAT_EDIT_APPLY_MODE.auto,
        docxEditRepresentation: DOCX_EDIT_REPRESENTATION.direct,
      };
    case CHAT_EDIT_MODE_OPTION_ID.manual:
      return { editApplyMode: CHAT_EDIT_APPLY_MODE.manual };
    default:
      optionId satisfies never;
      return panic("Unsupported chat edit-mode option id");
  }
};

/** The representation to send for this selection, or `undefined` for
 *  "manual" (the server ignores it in manual mode; omitting it keeps the
 *  request body honest about what the selection actually carries). */
export const docxEditRepresentationForSelection = (
  selection: ChatEditModeSelection,
): DocxEditRepresentation | undefined =>
  selection.editApplyMode === CHAT_EDIT_APPLY_MODE.auto
    ? selection.docxEditRepresentation
    : undefined;

export type ActiveDocxEditModeState =
  | { type: "unavailable" }
  | { type: "manual"; selection: { editApplyMode: "manual" } }
  | { type: "selectable"; selection: ChatEditModeSelection };

type ResolveActiveDocxEditModeStateOptions = {
  activeFileEditable: boolean | undefined;
  docxEditable: boolean | undefined;
  hasDocxEditSurface: boolean;
  /**
   * The DOCX is unsafe for Folio to rewrite. Editing is blocked entirely, so
   * the AI edit tool must not be advertised (auto mode would otherwise create a
   * new version of a document that can't round-trip) — the mode resolves to
   * `unavailable` regardless of lock state.
   */
  unsafe?: boolean | undefined;
  selection: ChatEditModeSelection;
};

/**
 * Keep server-side auto edits away from a live browser/desktop edit session:
 * auto targets the persisted current version while an unlocked editor may
 * contain newer unsaved bytes. Historical/non-editable files expose no edit
 * tool; unlocked current files use manual review; a locked current file lets
 * the user choose auto or manual.
 */
export const resolveActiveDocxEditModeState = ({
  activeFileEditable,
  docxEditable,
  hasDocxEditSurface,
  unsafe,
  selection,
}: ResolveActiveDocxEditModeStateOptions): ActiveDocxEditModeState => {
  if (unsafe === true || !hasDocxEditSurface || activeFileEditable !== true) {
    return { type: "unavailable" };
  }
  if (docxEditable === true) {
    return {
      type: "manual",
      selection: { editApplyMode: CHAT_EDIT_APPLY_MODE.manual },
    };
  }
  if (docxEditable === false) {
    return { type: "selectable", selection };
  }
  return { type: "unavailable" };
};

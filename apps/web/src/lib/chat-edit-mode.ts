import { panic } from "better-result";

import {
  CHAT_EDIT_APPLY_MODE,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  DOCX_EDIT_REPRESENTATION,
  type ChatEditApplyMode,
  type DocxEditRepresentation,
} from "@stll/api-contract";

export { CHAT_EDIT_APPLY_MODE, DOCX_EDIT_REPRESENTATION };
export type { ChatEditApplyMode, DocxEditRepresentation };

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

type MissingChatEditModeOptionId = Exclude<
  ChatEditModeOptionId,
  (typeof CHAT_EDIT_MODE_OPTION_IDS)[number]
>;

true satisfies MissingChatEditModeOptionId extends never ? true : never;

const resolveChatEditModeOptionId = (
  applyMode: ChatEditApplyMode,
  representation: DocxEditRepresentation,
): ChatEditModeOptionId => {
  switch (applyMode) {
    case CHAT_EDIT_APPLY_MODE.manual:
      return CHAT_EDIT_MODE_OPTION_ID.manual;
    case CHAT_EDIT_APPLY_MODE.auto:
      switch (representation) {
        case DOCX_EDIT_REPRESENTATION.trackedChanges:
          return CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges;
        case DOCX_EDIT_REPRESENTATION.direct:
          return CHAT_EDIT_MODE_OPTION_ID.autoDirect;
        default:
          representation satisfies never;
          return panic(`Unhandled representation: ${String(representation)}`);
      }
    default:
      applyMode satisfies never;
      return panic(`Unhandled apply mode: ${String(applyMode)}`);
  }
};

export const DEFAULT_CHAT_EDIT_MODE_OPTION_ID = resolveChatEditModeOptionId(
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
);

export const isChatEditModeOptionId = (
  value: unknown,
): value is ChatEditModeOptionId =>
  typeof value === "string" &&
  CHAT_EDIT_MODE_OPTION_IDS.some((optionId) => optionId === value);

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

/**
 * DOCX rewrite-safety, resolved from Folio's compatibility probe:
 * - `safe`: confirmed round-trippable; editing may be offered.
 * - `unsafe`: Folio can't rewrite it without corrupting it; editing is blocked.
 * - `checking`: the probe hasn't resolved yet. Treated as non-editable so the
 *   AI edit tool is never advertised before the result lands (a prompt sent in
 *   that window must not be able to auto-edit an eventually-unsafe document).
 *
 * A named state, not a boolean, so callers can't conflate "unchecked" with
 * "safe" (they are distinct: only `safe` unlocks editing).
 */
export type DocxEditSafety = "safe" | "checking" | "unsafe";

type ResolveActiveDocxEditModeStateOptions = {
  activeFileEditable: boolean | undefined;
  docxEditable: boolean | undefined;
  hasDocxEditSurface: boolean;
  /** Editing is only offered when the DOCX is confirmed `safe`. */
  safety: DocxEditSafety;
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
  safety,
  selection,
}: ResolveActiveDocxEditModeStateOptions): ActiveDocxEditModeState => {
  if (safety !== "safe" || !hasDocxEditSurface || activeFileEditable !== true) {
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

import {
  FileDiffIcon,
  LockIcon,
  UserCheckIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";

import type { TranslationKey } from "@/i18n/types";
import type {
  ActiveDocxEditModeState,
  ChatEditModeOptionId,
  DocxEditSafety,
} from "@/lib/chat-edit-mode";
import {
  CHAT_EDIT_MODE_OPTION_ID,
  CHAT_EDIT_MODE_OPTION_IDS,
} from "@/lib/chat-edit-mode";

// Tracked changes is a diff — insertions and deletions recorded in the
// document — not a rewind. The clock-arrow glyph read as "restore an earlier
// version", which is a different (and destructive-sounding) promise.
const OPTION_ICON = {
  [CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges]: FileDiffIcon,
  [CHAT_EDIT_MODE_OPTION_ID.autoDirect]: WandSparklesIcon,
  [CHAT_EDIT_MODE_OPTION_ID.manual]: UserCheckIcon,
} as const satisfies Record<ChatEditModeOptionId, LucideIcon>;

const OPTION_LABEL_KEY = {
  [CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges]:
    "chat.editMode.autoTrackedChanges",
  [CHAT_EDIT_MODE_OPTION_ID.autoDirect]: "chat.editMode.autoDirect",
  [CHAT_EDIT_MODE_OPTION_ID.manual]: "chat.editMode.manual",
} as const satisfies Record<ChatEditModeOptionId, TranslationKey>;

const OPTION_DESCRIPTION_KEY = {
  [CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges]:
    "chat.editMode.autoTrackedChangesDescription",
  [CHAT_EDIT_MODE_OPTION_ID.autoDirect]: "chat.editMode.autoDirectDescription",
  [CHAT_EDIT_MODE_OPTION_ID.manual]: "chat.editMode.manualDescription",
} as const satisfies Record<ChatEditModeOptionId, TranslationKey>;

/**
 * Quiet, non-interactive dock chip shown when the DOCX cannot be edited
 * safely; renders nothing for any other safety state. The mode picker itself
 * lives in the composer's (+) menu ({@link ComposerEditModeSubmenu}); this
 * chip is the only edit-mode presence the dock keeps, so the tooltip carries
 * the reason editing is off.
 */
export const DocxEditSafetyChip = ({ safety }: { safety: DocxEditSafety }) => {
  const t = useTranslations();
  if (safety !== "unsafe") {
    return null;
  }
  return (
    <span
      className="text-muted-foreground text-2xs inline-flex max-w-[180px] min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5"
      title={t("folio.unsupportedDocxEditDescription")}
    >
      <LockIcon aria-hidden="true" className="size-3 shrink-0" />
      {/* min-w-0: a flex item defaults to min-width:auto, so without this the
          label refuses to shrink below its content and the chip overruns
          max-w, colliding with the row's end cluster in longer locales. */}
      <span className="min-w-0 truncate">{t("folio.viewOnly")}</span>
    </span>
  );
};

/** Enables and drives the (+) menu's Edit mode submenu. */
export type ComposerEditModeMenuProps = {
  optionId: ChatEditModeOptionId;
  onChange: (optionId: ChatEditModeOptionId) => void;
};

type ComposerEditModeMenuForOptions = ComposerEditModeMenuProps & {
  state: ActiveDocxEditModeState;
};

/** The (+) menu's Edit mode props for the current DOCX state: only a
 *  selectable state (locked, safely-editable current file) offers the picker. */
export const composerEditModeMenuFor = ({
  state,
  optionId,
  onChange,
}: ComposerEditModeMenuForOptions): ComposerEditModeMenuProps | undefined =>
  state.type === "selectable" ? { optionId, onChange } : undefined;

/**
 * The (+) menu's DOCX auto-edit review mode submenu: "auto · track changes"
 * (default), "auto · rewrite", or "manual review". The trigger carries the
 * current option's icon so the mode stays readable without opening it. Only
 * rendered by callers where a locked, safely-editable DOCX is open (see
 * `resolveActiveDocxEditModeState`); Template Studio never renders this and
 * pins `editApplyMode: "manual"` directly instead, since it has no
 * entity-backed active file for the automatic `suggest_changes` apply to
 * target.
 */
export const ComposerEditModeSubmenu = ({
  optionId,
  onChange,
}: ComposerEditModeMenuProps) => {
  const t = useTranslations();
  const TriggerIcon = OPTION_ICON[optionId];

  return (
    <MenuSub>
      <MenuSubTrigger>
        <TriggerIcon />
        {t("chat.composerMenu.editMode")}
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <MenuRadioGroup value={optionId}>
          {CHAT_EDIT_MODE_OPTION_IDS.map((option) => {
            const Icon = OPTION_ICON[option];
            return (
              <MenuRadioItem
                key={option}
                onClick={() => onChange(option)}
                value={option}
              >
                <span className="flex min-w-0 items-start gap-1.5">
                  <Icon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">
                      {t(OPTION_LABEL_KEY[option])}
                    </span>
                    <span className="text-muted-foreground text-2xs text-wrap">
                      {t(OPTION_DESCRIPTION_KEY[option])}
                    </span>
                  </span>
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
};

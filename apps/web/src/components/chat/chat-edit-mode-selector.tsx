import {
  ChevronDownIcon,
  HistoryIcon,
  UserCheckIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/components/menu";

import type { TranslationKey } from "@/i18n/types";
import type { ChatEditModeOptionId } from "@/lib/chat-edit-mode";
import {
  CHAT_EDIT_MODE_OPTION_ID,
  CHAT_EDIT_MODE_OPTION_IDS,
} from "@/lib/chat-edit-mode";

const OPTION_ICON = {
  [CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges]: HistoryIcon,
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

type ChatEditModeSelectorProps = {
  optionId: ChatEditModeOptionId;
  onChange: (optionId: ChatEditModeOptionId) => void;
};

/**
 * Composer toolbar control for the DOCX auto-edit review mode: "auto ·
 * track changes" (default), "auto · rewrite", or "manual review". Mirrors
 * `ChatMatterPicker`'s inline chip-trigger shape (icon + short label +
 * chevron) so it sits at home among the composer dock's other quiet,
 * borderless controls. Only rendered by callers where an editable DOCX is
 * actually open (see `hasDocxEditSurface`/`docxEditable` in
 * `file-chat-overlay.tsx`) -- Template Studio never renders this and pins
 * `editApplyMode: "manual"` directly instead, since it has no entity-backed
 * active file for `edit_workspace_document` to target.
 */
export const ChatEditModeSelector = ({
  optionId,
  onChange,
}: ChatEditModeSelectorProps) => {
  const t = useTranslations();
  const TriggerIcon = OPTION_ICON[optionId];

  return (
    <Menu>
      <MenuTrigger
        className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex max-w-[180px] items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
        title={t(OPTION_LABEL_KEY[optionId])}
      >
        <TriggerIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{t(OPTION_LABEL_KEY[optionId])}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3 shrink-0 opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64" sideOffset={6}>
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
                    <span className="text-muted-foreground text-[11px] text-wrap">
                      {t(OPTION_DESCRIPTION_KEY[option])}
                    </span>
                  </span>
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};

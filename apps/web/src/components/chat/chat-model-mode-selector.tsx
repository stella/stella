import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  BrainCircuitIcon,
  ChevronDownIcon,
  GaugeIcon,
  MessageCircleIcon,
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

import type { ComposerModelsMenuProps } from "@/components/chat/composer-plus-menu";
import { modelOptionsOptions } from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";

const CHAT_MODEL_MODE = {
  standard: "standard",
  deepThinking: "deepThinking",
  fast: "fast",
} as const;

type ChatModelMode = (typeof CHAT_MODEL_MODE)[keyof typeof CHAT_MODEL_MODE];

const MODE_LABEL_KEY = {
  [CHAT_MODEL_MODE.standard]: "chat.modelMode.standard",
  [CHAT_MODEL_MODE.deepThinking]: "chat.modelMode.deepThinking",
  [CHAT_MODEL_MODE.fast]: "organization.aiConfig.roles.fast",
} as const satisfies Record<ChatModelMode, TranslationKey>;

const MODE_DESCRIPTION_KEY = {
  [CHAT_MODEL_MODE.standard]: "chat.modelMode.standardDescription",
  [CHAT_MODEL_MODE.deepThinking]: "chat.modelMode.deepThinkingDescription",
  [CHAT_MODEL_MODE.fast]: "chat.modelMode.fastDescription",
} as const satisfies Record<ChatModelMode, TranslationKey>;

const MODE_ICON = {
  [CHAT_MODEL_MODE.standard]: MessageCircleIcon,
  [CHAT_MODEL_MODE.deepThinking]: BrainCircuitIcon,
  [CHAT_MODEL_MODE.fast]: GaugeIcon,
} as const satisfies Record<ChatModelMode, LucideIcon>;

type ChatModelModeSelectorProps = {
  disabled: boolean;
  models: ComposerModelsMenuProps;
};

/**
 * Friendly, always-visible counterpart to the technical model list in (+).
 * Each mode resolves to the organization's configured role model; provider
 * names stay out of the primary chat UX while power users retain the full
 * picker one level away.
 */
export const ChatModelModeSelector = ({
  disabled,
  models,
}: ChatModelModeSelectorProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    ...modelOptionsOptions(models.activeOrganizationId),
    enabled: open,
  });

  const options = resolveModeOptions(data?.modeValues);
  const selectedMode = resolveSelectedMode({
    options,
    selectedModel: models.selectedModel,
  });
  const TriggerIcon = selectedMode
    ? MODE_ICON[selectedMode]
    : MessageCircleIcon;
  const triggerLabel = selectedMode
    ? t(MODE_LABEL_KEY[selectedMode])
    : t("organization.matterNumber.presets.custom");

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        aria-label={t("chat.modelMode.select")}
        className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex max-w-40 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors"
        disabled={disabled}
        title={triggerLabel}
      >
        <TriggerIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3 shrink-0 opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72" side="top" sideOffset={6}>
        <MenuRadioGroup value={models.selectedModel ?? ""}>
          {options.map((option) => {
            const Icon = MODE_ICON[option.mode];
            return (
              <MenuRadioItem
                key={option.mode}
                onClick={() => {
                  const nextModel = option.value || null;
                  if (nextModel !== models.selectedModel) {
                    models.selectModel(nextModel);
                  }
                }}
                value={option.value}
              >
                <span className="flex min-w-0 items-start gap-2 py-0.5">
                  <Icon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span>{t(MODE_LABEL_KEY[option.mode])}</span>
                    <span className="text-muted-foreground text-[11px] text-wrap">
                      {t(MODE_DESCRIPTION_KEY[option.mode])}
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

type ModeValues = {
  deepThinking: string | null;
  fast: string | null;
};

type ModelModeOption = {
  mode: ChatModelMode;
  value: string;
};

const resolveModeOptions = (
  modeValues: ModeValues | undefined,
): ModelModeOption[] => {
  const options: ModelModeOption[] = [
    { mode: CHAT_MODEL_MODE.standard, value: "" },
  ];
  if (modeValues?.deepThinking) {
    options.push({
      mode: CHAT_MODEL_MODE.deepThinking,
      value: modeValues.deepThinking,
    });
  }
  if (modeValues?.fast && modeValues.fast !== modeValues.deepThinking) {
    options.push({ mode: CHAT_MODEL_MODE.fast, value: modeValues.fast });
  }
  return options;
};

const resolveSelectedMode = ({
  options,
  selectedModel,
}: {
  options: ModelModeOption[];
  selectedModel: string | null;
}): ChatModelMode | null => {
  if (selectedModel === null) {
    return CHAT_MODEL_MODE.standard;
  }
  return options.find((option) => option.value === selectedModel)?.mode ?? null;
};

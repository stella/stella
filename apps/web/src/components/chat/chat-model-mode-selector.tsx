import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  BrainCircuitIcon,
  CpuIcon,
  GaugeIcon,
  MessageCircleIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";

import { PROVIDER_LABELS } from "@/components/ai-config-role-models.logic";
import type { ComposerModelsMenuProps } from "@/components/chat/composer-plus-menu";
import { modelOptionsOptions } from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";
import {
  CHAT_MODEL_MODE,
  type ChatModelFavorite,
  type ChatModelMode,
  useChatModelFavoriteStore,
} from "@/lib/chat-model-favorite-store";

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
  disabled?: boolean;
  models: ComposerModelsMenuProps;
};

/**
 * Compact access to friendly modes and exact models. Modes resolve to the
 * organization's configured role model; pinned modes therefore follow later
 * configuration changes, while pinned exact models retain their identity.
 */
export const ChatModelModeSelector = ({
  disabled = false,
  models,
}: ChatModelModeSelectorProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    ...modelOptionsOptions(models.activeOrganizationId),
    enabled: open || models.selectedModel !== null,
  });
  const favorite = useChatModelFavoriteStore(
    (state) => state.favoritesByOrganization[models.activeOrganizationId],
  );
  const setFavorite = useChatModelFavoriteStore((state) => state.setFavorite);

  const options = resolveModeOptions(data?.modeValues);
  const selectedMode = resolveSelectedMode({
    options,
    selectedModel: models.selectedModel,
  });
  const selectedExactModel = data?.options.find(
    (option) => option.value === models.selectedModel,
  );
  const TriggerIcon = selectedMode ? MODE_ICON[selectedMode] : CpuIcon;
  let triggerLabel = models.selectedModel ?? t("chat.modelMode.exactModels");
  if (selectedExactModel) {
    triggerLabel = formatModelLabel(selectedExactModel);
  }
  if (selectedMode) {
    triggerLabel = t(MODE_LABEL_KEY[selectedMode]);
  }
  const toggleFavorite = (nextFavorite: ChatModelFavorite) => {
    setFavorite(
      models.activeOrganizationId,
      isSameFavorite(favorite, nextFavorite) ? null : nextFavorite,
    );
  };

  const selectValue = (value: string) => {
    const nextModel = value === "" ? null : value;
    if (nextModel !== models.selectedModel) {
      models.selectModel(nextModel);
    }
  };

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <Button
            aria-label={t("chat.modelMode.select")}
            className="text-muted-foreground hover:text-foreground"
            disabled={disabled}
            size="icon-xs"
            tooltip={triggerLabel}
            variant="ghost"
          />
        }
      >
        <TriggerIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72" side="top" sideOffset={6}>
        <MenuRadioGroup value={models.selectedModel ?? ""}>
          {options.map((option) => {
            const Icon = MODE_ICON[option.mode];
            const label = t(MODE_LABEL_KEY[option.mode]);
            const optionFavorite = {
              type: "mode",
              mode: option.mode,
            } as const satisfies ChatModelFavorite;
            const pinned = isSameFavorite(favorite, optionFavorite);
            return (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto]"
                key={option.mode}
              >
                <MenuRadioItem
                  className="pe-2"
                  onClick={() => selectValue(option.value)}
                  value={option.value}
                >
                  <span className="flex min-w-0 items-start gap-2 py-0.5">
                    <Icon className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-col">
                      <span>{label}</span>
                      <span className="text-muted-foreground text-[11px] text-wrap">
                        {t(MODE_DESCRIPTION_KEY[option.mode])}
                      </span>
                    </span>
                  </span>
                </MenuRadioItem>
                <FavoriteMenuItem
                  label={label}
                  onClick={() => toggleFavorite(optionFavorite)}
                  pinned={pinned}
                />
              </div>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>
            <CpuIcon />
            {t("chat.modelMode.exactModels")}
          </MenuSubTrigger>
          <MenuSubPopup className="w-[min(32rem,calc(100vw-2rem))] max-w-(--available-width)">
            {data ? (
              <MenuRadioGroup value={models.selectedModel ?? ""}>
                {data.options.map((option) => {
                  const label = formatModelLabel(option);
                  const optionFavorite = {
                    type: "model",
                    value: option.value,
                  } as const satisfies ChatModelFavorite;
                  const pinned = isSameFavorite(favorite, optionFavorite);
                  return (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_auto]"
                      key={option.value}
                    >
                      <MenuRadioItem
                        className="grid-cols-[1rem_minmax(0,1fr)] pe-2"
                        onClick={() => selectValue(option.value)}
                        value={option.value}
                      >
                        <span className="block [overflow-wrap:anywhere] whitespace-normal">
                          <bdi>{label}</bdi>
                        </span>
                      </MenuRadioItem>
                      <FavoriteMenuItem
                        label={label}
                        onClick={() => toggleFavorite(optionFavorite)}
                        pinned={pinned}
                      />
                    </div>
                  );
                })}
              </MenuRadioGroup>
            ) : (
              <MenuItem disabled>{t("common.loading")}</MenuItem>
            )}
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
};

const PROVIDER_LABEL_FALLBACKS: Readonly<Partial<Record<string, string>>> =
  PROVIDER_LABELS;

type ModelOption = {
  modelId: string;
  provider: string;
  value: string;
};

const formatModelLabel = (option: ModelOption): string =>
  `${PROVIDER_LABEL_FALLBACKS[option.provider] ?? option.provider} · ${option.modelId}`;

const FavoriteMenuItem = ({
  label,
  onClick,
  pinned,
}: {
  label: string;
  onClick: () => void;
  pinned: boolean;
}) => {
  const t = useTranslations();
  const action = t(pinned ? "common.unpin" : "common.pin");
  const Icon = pinned ? PinOffIcon : PinIcon;
  return (
    <MenuItem
      aria-label={`${action}: ${label}`}
      className="justify-center px-2"
      onClick={onClick}
      title={`${action}: ${label}`}
    >
      <Icon />
    </MenuItem>
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

const isSameFavorite = (
  current: ChatModelFavorite | undefined,
  candidate: ChatModelFavorite,
): boolean => {
  if (!current || current.type !== candidate.type) {
    return false;
  }
  switch (candidate.type) {
    case "mode":
      return current.type === "mode" && current.mode === candidate.mode;
    case "model":
      return current.type === "model" && current.value === candidate.value;
    default:
      candidate satisfies never;
      return false;
  }
};

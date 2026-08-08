import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { BlendIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";

import {
  PROVIDER_LABELS,
  type ProviderValue,
} from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import { modelSelectionLabel } from "@/components/chat/chat-model-selector.logic";
import type { ComposerModelsMenuProps } from "@/components/chat/composer-plus-menu";
import { modelOptionsOptions } from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";

const EFFORT_LABEL_KEY = {
  none: "chat.modelSelector.effortValues.none",
  minimal: "chat.modelSelector.effortValues.minimal",
  low: "chat.modelSelector.effortValues.low",
  medium: "chat.modelSelector.effortValues.medium",
  high: "chat.modelSelector.effortValues.high",
  xhigh: "chat.modelSelector.effortValues.xhigh",
  max: "chat.modelSelector.effortValues.max",
} as const satisfies Record<ReasoningEffort, TranslationKey>;

type ChatModelSelectorProps = {
  disabled?: boolean;
  models: ComposerModelsMenuProps;
};

type ModelOption = {
  displayName: string;
  iconProvider: ProviderValue;
  modelId: string;
  provider: ProviderValue;
  reasoningEfforts: readonly ReasoningEffort[] | null;
  value: string;
};

/** Auto routing plus explicit model/effort selection for one thread. */
export const ChatModelSelector = ({
  disabled = false,
  models,
}: ChatModelSelectorProps) => {
  const t = useTranslations();
  const {
    activeOrganizationId,
    selectedModel,
    selectedReasoningEffort,
    selectModel,
  } = models;
  const [open, setOpen] = useState(false);
  const [detailsRequested, setDetailsRequested] = useState(false);
  const { data } = useQuery({
    ...modelOptionsOptions(activeOrganizationId),
    enabled: open || detailsRequested || selectedModel !== null,
  });
  const selectedOption = data?.options.find(
    (option) => option.value === selectedModel,
  );
  const triggerLabel = selectedOption
    ? modelSelectionLabel({
        defaultEffortLabel: t(
          "chat.modelSelector.effortValues.providerDefault",
        ),
        displayName: selectedOption.displayName,
        reasoningEffort: selectedReasoningEffort,
        translateEffort: (effort) => t(EFFORT_LABEL_KEY[effort]),
      })
    : t("chat.modelSelector.autoLabel");

  const selectAuto = () => {
    if (selectedModel !== null) {
      selectModel({ model: null, reasoningEffort: null });
    }
  };

  const selectOption = (
    option: ModelOption,
    reasoningEffort: ReasoningEffort | null = null,
  ) => {
    if (
      selectedModel === option.value &&
      selectedReasoningEffort === reasoningEffort
    ) {
      return;
    }
    selectModel({ model: option.value, reasoningEffort });
  };

  const disableAuto = () => {
    if (selectedModel !== null) {
      return;
    }
    const option =
      data?.options.find(
        (candidate) => candidate.value === data.defaultValue,
      ) ?? data?.options.at(0);
    if (option) {
      selectOption(option);
    }
  };

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <Button
            aria-label={triggerLabel}
            className={
              selectedModel === null
                ? "text-muted-foreground hover:text-foreground gap-1.5"
                : "bg-accent text-accent-foreground hover:text-accent-foreground gap-1.5"
            }
            disabled={disabled}
            onFocus={() => setDetailsRequested(true)}
            onMouseEnter={() => setDetailsRequested(true)}
            size="xs"
            variant="ghost"
          />
        }
        tooltip={triggerLabel}
      >
        <ModelTriggerIcon provider={selectedOption?.iconProvider ?? null} />
        <BidiText as="span" className="max-w-36 truncate">
          {triggerLabel}
        </BidiText>
      </MenuTrigger>
      <MenuPopup align="start" className="w-80" side="top" sideOffset={6}>
        <MenuCheckboxItem
          checked={selectedModel === null}
          closeOnClick={false}
          onCheckedChange={(checked) => {
            if (checked) {
              selectAuto();
            } else {
              disableAuto();
            }
          }}
          variant="switch"
        >
          <span className="flex flex-col py-0.5">
            <span>{t("chat.modelSelector.autoLabel")}</span>
            <span className="text-muted-foreground text-[11px] text-wrap">
              {t("chat.modelSelector.autoDescription")}
            </span>
          </span>
        </MenuCheckboxItem>
        <MenuSeparator />
        {data ? (
          <MenuRadioGroup value={selectedModel ?? ""}>
            {data.options.map((option) => (
              <ModelOptionRow
                key={option.value}
                onSelect={(reasoningEffort) =>
                  selectOption(option, reasoningEffort)
                }
                option={option}
                selected={selectedModel === option.value}
                selectedReasoningEffort={
                  selectedModel === option.value
                    ? selectedReasoningEffort
                    : null
                }
              />
            ))}
          </MenuRadioGroup>
        ) : (
          <div className="text-muted-foreground px-2 py-1.5 text-sm">
            {t("common.loading")}
          </div>
        )}
      </MenuPopup>
    </Menu>
  );
};

const ModelOptionRow = ({
  onSelect,
  option,
  selected,
  selectedReasoningEffort,
}: {
  onSelect: (reasoningEffort: ReasoningEffort | null) => void;
  option: ModelOption;
  selected: boolean;
  selectedReasoningEffort: ReasoningEffort | null;
}) => {
  const t = useTranslations();
  const displayedEffort = selected ? selectedReasoningEffort : null;
  const routedProviderDiffers = option.provider !== option.iconProvider;

  return (
    <div className="hover:bg-accent has-[[data-checked]]:bg-accent has-[[data-highlighted]]:bg-accent has-[[data-highlighted]]:text-accent-foreground grid grid-cols-[minmax(0,1fr)_auto] rounded-sm">
      <MenuRadioItem
        className="grid-cols-[1rem_minmax(0,1fr)] pe-2 data-highlighted:bg-transparent"
        onClick={() => onSelect(displayedEffort)}
        value={option.value}
      >
        <span className="flex min-w-0 items-start gap-2 py-0.5">
          <AIProviderIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
            provider={option.iconProvider}
          />
          <span className="flex min-w-0 flex-col">
            <BidiText as="span" className="truncate">
              {option.displayName}
            </BidiText>
            {routedProviderDiffers && (
              <span className="text-muted-foreground text-[11px]">
                {t("chat.modelSelector.viaProvider", {
                  provider: PROVIDER_LABELS[option.provider],
                })}
              </span>
            )}
          </span>
        </span>
      </MenuRadioItem>
      {option.reasoningEfforts !== null && (
        <EffortSubmenu
          efforts={option.reasoningEfforts}
          onSelect={onSelect}
          selected={selected}
          value={displayedEffort}
        />
      )}
    </div>
  );
};

const ModelTriggerIcon = ({ provider }: { provider: ProviderValue | null }) =>
  provider === null ? (
    <BlendIcon aria-hidden="true" className="size-3.5" />
  ) : (
    <AIProviderIcon
      aria-hidden="true"
      className="size-3.5"
      provider={provider}
    />
  );

const EffortSubmenu = ({
  efforts,
  onSelect,
  selected,
  value,
}: {
  efforts: readonly ReasoningEffort[];
  onSelect: (reasoningEffort: ReasoningEffort | null) => void;
  selected: boolean;
  value: ReasoningEffort | null;
}) => {
  const t = useTranslations();
  return (
    <MenuSub>
      <MenuSubTrigger
        aria-label={t("chat.modelSelector.effortLabel")}
        className="text-muted-foreground px-2 data-highlighted:bg-transparent"
      >
        {value === null
          ? t("chat.modelSelector.effortValues.providerDefault")
          : t(EFFORT_LABEL_KEY[value])}
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup value={selected ? (value ?? "provider-default") : ""}>
          <MenuRadioItem
            onClick={() => onSelect(null)}
            value="provider-default"
          >
            {t("chat.modelSelector.effortValues.providerDefault")}
          </MenuRadioItem>
          {efforts.map((effort) => (
            <MenuRadioItem
              key={effort}
              onClick={() => onSelect(effort)}
              value={effort}
            >
              {t(EFFORT_LABEL_KEY[effort])}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
};

import { useId, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";
import { groupReasoningEfforts } from "@stll/chat/model-selector";
import { BidiText } from "@stll/ui/bidi-text";
import {
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";

import {
  PROVIDER_LABELS,
  type ProviderValue,
} from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import {
  ComposerSubmenuSearch,
  useFocusSearchOnOpen,
} from "@/components/chat/composer-submenu-search";
import { modelOptionsOptions } from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

export const CHAT_MODEL_MENU_POPUP_CLASS_NAME =
  "w-[min(32rem,calc(100vw-2rem))] max-w-(--available-width)";

export const EFFORT_LABEL_KEY = {
  none: "chat.modelSelector.effortValues.none",
  minimal: "chat.modelSelector.effortValues.minimal",
  low: "chat.modelSelector.effortValues.low",
  medium: "chat.modelSelector.effortValues.medium",
  high: "chat.modelSelector.effortValues.high",
  xhigh: "chat.modelSelector.effortValues.xhigh",
  max: "chat.modelSelector.effortValues.max",
} as const satisfies Record<ReasoningEffort, TranslationKey>;

export type ComposerModelsMenuProps = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
  /** Current per-thread override ("provider::modelId"), or null when the
   *  thread uses the org default. */
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort | null;
  /** Persist the chosen model (see `useChatModelSelection`). Fire-and-forget
   *  here: the caller's own send path is what awaits the outcome via
   *  `awaitPendingSelection`, not this menu. */
  selectModel: (selection: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
  }) => void;
};

type ModelOption = {
  defaultReasoningEffort: ReasoningEffort | null;
  displayName: string;
  iconProvider: ProviderValue;
  provider: ProviderValue;
  reasoningEfforts: readonly ReasoningEffort[] | null;
  value: string;
};

const EMPTY_MODEL_OPTIONS: readonly ModelOption[] = [];

type ChatModelOptionsMenuProps = {
  enabled: boolean;
  models: ComposerModelsMenuProps;
  open: boolean;
};

/** The single model-picker body shared by the composer (+) menu and dock. */
export const ChatModelOptionsMenu = ({
  enabled,
  models,
  open,
}: ChatModelOptionsMenuProps) => {
  const t = useTranslations();
  const {
    activeOrganizationId,
    selectedModel,
    selectedReasoningEffort,
    selectModel,
  } = models;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  const { data, isPending } = useQuery({
    ...modelOptionsOptions(activeOrganizationId),
    enabled,
  });

  const query = search.trim().toLowerCase();
  let filteredOptions = EMPTY_MODEL_OPTIONS;
  if (data) {
    filteredOptions = data.options;
  }
  if (query) {
    filteredOptions = filteredOptions.filter((option) =>
      option.displayName.toLowerCase().includes(query),
    );
  }

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

  let optionRows = (
    <MenuRadioGroup value={selectedModel ?? ""}>
      {filteredOptions.map((option) => (
        <ModelOptionRow
          key={option.value}
          onSelect={(reasoningEffort) => selectOption(option, reasoningEffort)}
          option={option}
          selected={selectedModel === option.value}
          selectedReasoningEffort={
            selectedModel === option.value ? selectedReasoningEffort : null
          }
        />
      ))}
    </MenuRadioGroup>
  );
  if (isPending) {
    optionRows = (
      <p className="text-muted-foreground px-2.5 py-2 text-xs">
        {t("common.loading")}
      </p>
    );
  } else if (filteredOptions.length === 0) {
    optionRows = (
      <p className="text-muted-foreground px-2.5 py-2 text-xs">
        {t("organization.aiConfig.noModelResults")}
      </p>
    );
  }

  return (
    <>
      <ComposerSubmenuSearch
        onChange={setSearch}
        placeholder={t("organization.aiConfig.modelIdPlaceholder")}
        ref={searchRef}
        value={search}
      />
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
      {optionRows}
    </>
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
    <div className="hover:bg-accent has-[[data-checked]]:bg-accent has-[[data-highlighted]]:bg-accent has-[[data-highlighted]]:text-accent-foreground grid grid-cols-[minmax(0,1fr)_auto_auto] rounded-sm">
      <MenuRadioItem
        className="pe-2 data-highlighted:bg-transparent"
        indicator="none"
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
      {option.reasoningEfforts !== null &&
        option.reasoningEfforts.length > 0 && (
          <>
            <EffortHelp />
            <EffortSubmenu
              efforts={option.reasoningEfforts}
              providerDefaultEffort={option.defaultReasoningEffort}
              onSelect={onSelect}
              selected={selected}
              value={displayedEffort}
            />
          </>
        )}
    </div>
  );
};

const EffortSubmenu = ({
  efforts,
  providerDefaultEffort,
  onSelect,
  selected,
  value,
}: {
  efforts: readonly ReasoningEffort[];
  providerDefaultEffort: ReasoningEffort | null;
  onSelect: (reasoningEffort: ReasoningEffort | null) => void;
  selected: boolean;
  value: ReasoningEffort | null;
}) => {
  const t = useTranslations();
  const descriptionId = useId();
  const groupedEfforts = groupReasoningEfforts(efforts);
  const displayedEffort = value ?? providerDefaultEffort;
  const selectedValue = value ?? providerDefaultEffort ?? "provider-default";
  const renderEffort = (effort: ReasoningEffort) => (
    <MenuRadioItem
      key={effort}
      onClick={() => onSelect(effort === providerDefaultEffort ? null : effort)}
      value={effort}
    >
      <span className="flex items-center gap-1.5">
        {t(EFFORT_LABEL_KEY[effort])}
        {effort === providerDefaultEffort && (
          <>
            <span
              aria-hidden="true"
              className="bg-muted-foreground size-1.5 rounded-full"
            />
            <span className="sr-only">
              ({t("chat.modelSelector.effortValues.providerDefault")})
            </span>
          </>
        )}
      </span>
    </MenuRadioItem>
  );

  return (
    <MenuSub>
      <span className="sr-only" id={descriptionId}>
        {t("chat.modelSelector.effortLabel")}
      </span>
      <MenuSubTrigger
        aria-describedby={descriptionId}
        className="text-muted-foreground min-w-28 px-2 data-highlighted:bg-transparent [&>svg:last-child]:!ms-auto"
      >
        {displayedEffort === null
          ? t("chat.modelSelector.effortValues.providerDefault")
          : t(EFFORT_LABEL_KEY[displayedEffort])}
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <MenuRadioGroup value={selected ? selectedValue : ""}>
          {providerDefaultEffort === null && (
            <MenuRadioItem
              onClick={() => onSelect(null)}
              value="provider-default"
            >
              {t("chat.modelSelector.effortValues.providerDefault")}
            </MenuRadioItem>
          )}
          {groupedEfforts.standard.map(renderEffort)}
          {groupedEfforts.extended.length > 0 && <MenuSeparator />}
          {groupedEfforts.extended.map(renderEffort)}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
};

const EffortHelp = () => {
  const t = useTranslations();
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("chat.modelSelector.effortHelpLabel")}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-11 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-72 text-xs text-pretty"
        side="inline-start"
        sideOffset={6}
      >
        {t("chat.modelSelector.effortHelpDescription")}
      </PopoverPopup>
    </Popover>
  );
};

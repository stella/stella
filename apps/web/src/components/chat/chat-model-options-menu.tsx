import { useId, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";
import { groupReasoningEfforts } from "@stll/chat/model-selector";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ChevronDownIcon, InfoIcon } from "@stll/ui/icons";
import {
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import {
  PROVIDER_LABELS,
  type ProviderValue,
} from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import { getModelPickerView } from "@/components/chat/chat-model-options-menu.logic";
import type {
  ModelPickerEntry,
  ModelRecommendation,
} from "@/components/chat/chat-model-options-menu.logic";
import {
  ComposerSubmenuSearch,
  useFocusSearchOnOpen,
} from "@/components/chat/composer-submenu-search";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { modelOptionsOptions } from "@/features/chat/queries";
import type { ChatModelBenchmarkOption } from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { sanitizeHref } from "@/lib/sanitize-href";
import { useQueryView } from "@/lib/use-query-view";

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
const EMPTY_BENCHMARK_OPTIONS: readonly ChatModelBenchmarkOption[] = [];

type ModelTradeoff = ChatModelBenchmarkOption["tradeoff"];

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
  // Remounted on every open (keyed by the host), so All models starts folded.
  const [allModelsExpanded, setAllModelsExpanded] = useState(false);
  const modelsQuery = useQuery({
    ...modelOptionsOptions(activeOrganizationId),
    enabled,
  });

  const modelsView = useQueryView(modelsQuery);
  const data = modelsView.type === "items" ? modelsView.items : undefined;
  const options: readonly ModelOption[] = data
    ? data.options
    : EMPTY_MODEL_OPTIONS;
  const view = getModelPickerView({
    benchmarks: data?.benchmarkOptions ?? EMPTY_BENCHMARK_OPTIONS,
    options,
    query: search,
    selectedValue: selectedModel,
  });

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

  const renderRow = ({
    option,
    recommendation,
    tradeoff,
  }: ModelPickerEntry<ModelOption>) => (
    <ModelOptionRow
      key={option.value}
      onSelect={(reasoningEffort) => selectOption(option, reasoningEffort)}
      option={option}
      recommendation={recommendation}
      selected={selectedModel === option.value}
      selectedReasoningEffort={
        selectedModel === option.value ? selectedReasoningEffort : null
      }
      tradeoff={tradeoff}
    />
  );

  const radioValue = selectedModel ?? "";
  const visibleCount =
    view.type === "all"
      ? view.entries.length
      : view.recommended.length + view.others.length;
  const optionRows = (() => {
    if (modelsView.type === "pending" || modelsView.type === "error") {
      return <QueryViewFeedback view={modelsView} />;
    }
    if (visibleCount === 0) {
      if (
        modelsView.type === "items" &&
        modelsView.refetchError !== undefined
      ) {
        return null;
      }
      return (
        <p className="text-muted-foreground px-2.5 py-2 text-xs">
          {t("organization.aiConfig.noModelResults")}
        </p>
      );
    }
    return view.type === "all" ? (
      <MenuRadioGroup value={radioValue}>
        {view.entries.map(renderRow)}
      </MenuRadioGroup>
    ) : (
      <>
        <MenuRadioGroup value={radioValue}>
          <div className="flex items-center">
            <MenuGroupLabel className="flex-1">
              {t("common.recommended")}
            </MenuGroupLabel>
            {data && (
              <RecommendedHelp
                benchmarkName={data.benchmarkMetadata.benchmarkName}
                licence={data.benchmarkMetadata.licence}
                sourceUrl={data.benchmarkMetadata.sourceUrl}
              />
            )}
          </div>
          {view.recommended.map(renderRow)}
        </MenuRadioGroup>
        <MenuItem
          aria-expanded={allModelsExpanded}
          closeOnClick={false}
          onClick={() => setAllModelsExpanded((expanded) => !expanded)}
        >
          <span className="text-muted-foreground flex-1">
            {t("chat.modelSelector.allModels", { count: visibleCount })}
          </span>
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-3.5 transition-transform duration-150",
              allModelsExpanded && "rotate-180",
            )}
          />
        </MenuItem>
        {allModelsExpanded && (
          <MenuRadioGroup
            aria-label={t("chat.modelSelector.allModels", {
              count: visibleCount,
            })}
            value={radioValue}
          >
            {view.others.map(renderRow)}
          </MenuRadioGroup>
        )}
      </>
    );
  })();

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
          <span className="text-muted-foreground text-2xs text-wrap">
            {t("chat.modelSelector.autoDescription")}
          </span>
        </span>
      </MenuCheckboxItem>
      <MenuSeparator />
      {modelsView.type === "items" && <QueryViewFeedback view={modelsView} />}
      {optionRows}
    </>
  );
};

const ModelOptionRow = ({
  onSelect,
  option,
  recommendation,
  selected,
  selectedReasoningEffort,
  tradeoff,
}: {
  onSelect: (reasoningEffort: ReasoningEffort | null) => void;
  option: ModelOption;
  recommendation: ModelRecommendation;
  selected: boolean;
  selectedReasoningEffort: ReasoningEffort | null;
  tradeoff: ModelTradeoff | null;
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
            <span className="flex min-w-0 items-center gap-1.5">
              <BidiText as="span" className="truncate">
                {option.displayName}
              </BidiText>
              {recommendation === "new" && (
                <span className="bg-muted text-muted-foreground text-2xs shrink-0 rounded px-1.5 py-px font-medium">
                  {t("chat.modelSelector.newModel")}
                </span>
              )}
            </span>
            {routedProviderDiffers && (
              <span className="text-muted-foreground text-2xs">
                {t("chat.modelSelector.viaProvider", {
                  provider: PROVIDER_LABELS[option.provider],
                })}
              </span>
            )}
            {tradeoff?.type === "dominated" && (
              <span className="text-muted-foreground text-2xs">
                {t("chat.modelSelector.belowFrontier")}
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
              tradeoff={tradeoff}
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
  tradeoff,
  value,
}: {
  efforts: readonly ReasoningEffort[];
  providerDefaultEffort: ReasoningEffort | null;
  onSelect: (reasoningEffort: ReasoningEffort | null) => void;
  selected: boolean;
  tradeoff: ModelTradeoff | null;
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
      <span className="flex w-full items-center gap-1.5">
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
        {tradeoff !== null && (
          <EffortTradeoffNote effort={effort} tradeoff={tradeoff} />
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
              <span className="flex w-full items-center gap-1.5">
                {t("chat.modelSelector.effortValues.providerDefault")}
                {tradeoff !== null && (
                  <EffortTradeoffNote effort={null} tradeoff={tradeoff} />
                )}
              </span>
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

/**
 * Muted suffix for an effort that is dominated or unusually expensive;
 * `effort: null` is the provider default.
 */
const EffortTradeoffNote = ({
  effort,
  tradeoff,
}: {
  effort: ReasoningEffort | null;
  tradeoff: ModelTradeoff;
}) => {
  const t = useTranslations();
  const dominated = tradeoff.dominatedReasoningEfforts.includes(effort);
  const premium = tradeoff.premiumReasoningEfforts.includes(effort);
  if (!dominated && !premium) {
    return null;
  }
  return (
    <span className="text-muted-foreground text-2xs ms-auto flex flex-col items-end text-end">
      {dominated && <span>{t("chat.modelSelector.belowFrontier")}</span>}
      {premium && <span>{t("chat.modelSelector.premiumCost")}</span>}
    </span>
  );
};

/** What "Recommended" means, with the attribution the rating licence asks for. */
const RecommendedHelp = ({
  benchmarkName,
  licence,
  sourceUrl,
}: {
  benchmarkName: string;
  licence: string;
  sourceUrl: string;
}) => {
  const t = useTranslations();
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("chat.modelSelector.recommendedHelpLabel")}
        render={
          <Button
            className="size-11 self-center sm:size-11"
            size="icon"
            variant="muted"
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-72"
        layer="popup"
        side="inline-start"
        sideOffset={6}
      >
        <div className="text-xs font-normal text-pretty">
          {t.rich("chat.modelSelector.recommendedHelpDescription", {
            benchmark: benchmarkName,
            licence,
            link: (chunks) => (
              <a
                className="hover:text-foreground underline"
                href={sanitizeHref(sourceUrl)}
                rel="noreferrer"
                target="_blank"
              >
                {chunks}
              </a>
            ),
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
};

const EffortHelp = () => {
  const t = useTranslations();
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("chat.modelSelector.effortHelpLabel")}
        render={
          <Button
            className="size-11 self-center sm:size-11"
            size="icon"
            variant="muted"
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-72 text-xs text-pretty"
        layer="popup"
        side="inline-start"
        sideOffset={6}
      >
        {t("chat.modelSelector.effortHelpDescription")}
      </PopoverPopup>
    </Popover>
  );
};

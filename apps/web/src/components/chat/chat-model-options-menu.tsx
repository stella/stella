import {
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";
import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunHarness,
  type ChatLocalRunTarget,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { groupReasoningEfforts } from "@stll/chat/model-selector";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, InfoIcon } from "@stll/ui/icons";
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
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import {
  PROVIDER_LABELS,
  type ProviderValue,
} from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import {
  EFFORT_LABEL_KEY,
  getModelPickerView,
} from "@/components/chat/chat-model-options-menu.logic";
import type {
  ModelLineage,
  ModelPickerBenchmark,
  ModelPickerEntry,
  ModelRecommendation,
} from "@/components/chat/chat-model-options-menu.logic";
import {
  ReadinessRetry,
  useHarnessHint,
} from "@/components/chat/chat-run-target-menu";
import {
  type ChatCloudStart,
  chatLocalHarnessOptionsFor,
  localRunMaxApprovals,
  localRunTargetFor,
  sameRunTarget,
} from "@/components/chat/chat-run-target-menu.logic";
import {
  ComposerSubmenuSearch,
  useFocusSearchOnOpen,
} from "@/components/chat/composer-submenu-search";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { ChatThreadRef } from "@/features/chat/chat-thread-ref-types";
import {
  localRunnersOptions,
  modelOptionsOptions,
} from "@/features/chat/queries";
import type { ChatModelBenchmarkOption } from "@/features/chat/queries";
import { useFormatter } from "@/i18n/formatting-context";
import { type QueryView, queryView } from "@/lib/query-view.logic";

export type ComposerModelsMenuProps = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
  /**
   * `loading` until the stored choice is known; the menu is disabled until
   * then, so no pick composes on a choice not yet read.
   */
  state: "loading" | "ready";
  /** Current per-thread override ("provider::modelId"), or null when the
   *  thread uses the org default. */
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort | null;
  /** Persist the chosen model (see `useChatComposerModels`). Fire-and-forget
   *  here: the caller's own send path is what awaits the outcome via
   *  `awaitPendingSelection`, not this menu. */
  selectModel: (selection: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
  }) => void;
  /** Where the thread's turns run; see `ChatRunOn`. */
  runTarget: ChatRunOn;
};

/**
 * Where a composer's turns run, as its model menu offers it. Required on
 * every menu, so a surface that starts or continues a thread cannot drop
 * the Run on choice by leaving a prop out: it takes the choice from
 * `useChatComposerModels`, or states `cloud_only` because its turns depend
 * on tools only stella's own models drive in this page (the live document
 * editor's suggestions, say).
 */
export type ChatRunOn =
  | {
      type: "choice";
      selected: ChatRunTarget;
      select: (target: ChatRunTarget) => void;
      /**
       * Why a new chat runs in the cloud although the member last chose
       * their computer, which the where chip says; `null` otherwise.
       */
      startedInCloud: ChatCloudStart | null;
    }
  | { type: "cloud_only" };

export const CHAT_RUN_ON_CLOUD_ONLY = {
  type: "cloud_only",
} as const satisfies ChatRunOn;

/** The target a composer's next turn runs on. */
export const chatRunOnTarget = (runOn: ChatRunOn): ChatRunTarget => {
  switch (runOn.type) {
    case "choice":
      return runOn.selected;
    case "cloud_only":
      return CHAT_CLOUD_RUN_TARGET;
    default:
      runOn satisfies never;
      return panic("Unknown Run on choice");
  }
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

/**
 * The maker whose mark a coding agent's models carry in the picker, as a
 * stella model's row carries its maker's.
 */
const HARNESS_PROVIDER = {
  codex: "openai",
  "claude-code": "anthropic",
  antigravity: "google",
} as const satisfies Record<ChatLocalRunHarness, ProviderValue>;

type ModelTradeoff = ChatModelBenchmarkOption["tradeoff"];

type ChatModelOptionsMenuProps = {
  enabled: boolean;
  models: ComposerModelsMenuProps;
  open: boolean;
};

/**
 * The single model-picker body shared by the composer (+) menu and the model
 * chip: the models of the place the chat runs, which the where chip picks.
 * In the cloud, Auto or one of stella's models; on the member's computer,
 * the models its coding agent offers. Both are the one `ModelPicker`, so the
 * two places can never look or behave apart.
 */
export const ChatModelOptionsMenu = ({
  enabled,
  models,
  open,
}: ChatModelOptionsMenuProps) => {
  const { runTarget } = models;
  if (runTarget.type === "choice" && runTarget.selected.kind === "local") {
    return (
      <LocalModelOptions
        activeOrganizationId={models.activeOrganizationId}
        enabled={enabled}
        onSelect={runTarget.select}
        open={open}
        selected={runTarget.selected}
      />
    );
  }
  return <CloudModelOptions enabled={enabled} models={models} open={open} />;
};

/** stella's own models: Auto routing or an explicit model and effort. */
const CloudModelOptions = ({
  enabled,
  models,
  open,
}: ChatModelOptionsMenuProps) => {
  const {
    activeOrganizationId,
    selectedModel,
    selectedReasoningEffort,
    selectModel,
  } = models;
  const modelsQuery = useQuery({
    ...modelOptionsOptions(activeOrganizationId),
    enabled,
  });

  const modelsView = queryView(modelsQuery);
  const data = modelsView.type === "items" ? modelsView.items : undefined;

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
    <ModelPicker
      auto={{
        checked: selectedModel === null,
        onCheckedChange: (checked) => {
          if (checked) {
            selectAuto();
          } else {
            disableAuto();
          }
        },
      }}
      benchmarks={data?.benchmarkOptions ?? EMPTY_BENCHMARK_OPTIONS}
      failed={null}
      gone={null}
      onSelect={selectOption}
      open={open}
      options={data ? data.options : EMPTY_MODEL_OPTIONS}
      recommendedHelp={
        data && (
          <RecommendedHelp
            benchmarkName={data.benchmarkMetadata.benchmarkName}
            licence={data.benchmarkMetadata.licence}
            sourceUrl={data.benchmarkMetadata.sourceUrl}
          />
        )
      }
      selectedReasoningEffort={selectedReasoningEffort}
      selectedValue={selectedModel}
      unavailable={null}
      view={modelsView}
    />
  );
};

type LocalModelOptionsProps = {
  activeOrganizationId: string;
  enabled: boolean;
  open: boolean;
  selected: ChatLocalRunTarget;
  onSelect: (target: ChatRunTarget) => void;
};

/**
 * The models the coding agent on the member's computer offers, every one of
 * them by the name the agent gives it, in the picker stella's own models
 * use: the agent's recommended model (the one it runs when none is named)
 * under Recommended, the rest under All models, each with the reasoning
 * efforts the agent offers for it. A model the agent no longer offers stays
 * listed, marked so, until another is picked.
 */
const LocalModelOptions = ({
  activeOrganizationId,
  enabled,
  open,
  selected,
  onSelect,
}: LocalModelOptionsProps) => {
  const t = useTranslations();
  const hint = useHarnessHint();
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled,
    }),
  );
  const readiness =
    runnersView.type === "items" ? runnersView.items : undefined;
  // A turn in a linked folder runs on the folder's computer: its models are
  // that computer's.
  const option = chatLocalHarnessOptionsFor(readiness, selected)?.find(
    (candidate) => candidate.harness === selected.harness,
  );
  const ready = option?.state === "ready" ? option : undefined;
  const provider = HARNESS_PROVIDER[selected.harness];
  const options: readonly ModelOption[] =
    ready?.models.map((model) => ({
      defaultReasoningEffort: null,
      displayName: model.label,
      iconProvider: provider,
      provider,
      reasoningEfforts: model.reasoningEfforts,
      value: model.id,
    })) ?? EMPTY_MODEL_OPTIONS;
  // An agent that marks no default (an older desktop) gets its models in
  // its own order, none called recommended.
  const recommendedId =
    ready?.models.find(({ isDefault }) => isDefault === true)?.id ?? null;
  const lineageOf = (value: string): ModelLineage => ({
    recommended: value === recommendedId,
  });
  const unavailable = (() => {
    if (readiness === undefined) {
      return null;
    }
    if (option === undefined) {
      return t("chat.localRun.stateUnavailable");
    }
    return option.state === "ready" ? null : hint(option);
  })();
  const offered = ready?.models.some(({ id }) => id === selected.model);
  const choose = (
    picked: ModelOption,
    reasoningEffort: ReasoningEffort | null,
  ) => {
    if (ready === undefined) {
      return;
    }
    const target = localRunTargetFor({
      selected,
      option: ready,
      model: picked.value,
      maxApprovals: localRunMaxApprovals(readiness),
    });
    // The picker offers only the efforts this model lists.
    const next =
      target.kind === "local" ? { ...target, reasoningEffort } : target;
    if (!sameRunTarget(next, selected)) {
      onSelect(next);
    }
  };
  return (
    <ModelPicker
      auto={null}
      benchmarks={EMPTY_BENCHMARK_OPTIONS}
      // The where chip says the same of a failed read of the computers.
      failed={
        runnersView.type === "error" ? (
          <ReadinessRetry retry={runnersView.retry} />
        ) : null
      }
      gone={
        ready !== undefined && offered === false
          ? { value: selected.model, label: selected.model }
          : null
      }
      lineageOf={lineageOf}
      onSelect={choose}
      open={open}
      options={options}
      recommendedHelp={null}
      selectedReasoningEffort={selected.reasoningEffort}
      selectedValue={selected.model}
      unavailable={unavailable}
      view={runnersView}
    />
  );
};

type ModelPickerProps<TData> = {
  /** The read of the place's models; a pending or failed one says so. */
  view: QueryView<TData, Error>;
  options: readonly ModelOption[];
  benchmarks: readonly ModelPickerBenchmark[];
  /** Which models are recommended; the catalogue decides for stella's. */
  lineageOf?: ((value: string) => ModelLineage | undefined) | undefined;
  /** What Recommended means, beside its label; `null` for none. */
  recommendedHelp: ReactNode;
  /** Auto routing, offered only where the place routes turns itself. */
  auto: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  } | null;
  selectedValue: string | null;
  selectedReasoningEffort: ReasoningEffort | null;
  onSelect: (
    option: ModelOption,
    reasoningEffort: ReasoningEffort | null,
  ) => void;
  /** Why the place offers no model now, in place of the list. */
  unavailable: string | null;
  /** What a failed read of the place's models says; the generic one if `null`. */
  failed: ReactElement | null;
  /** The chosen model when the place no longer offers it: listed, not choosable. */
  gone: { value: string; label: string } | null;
  open: boolean;
};

/**
 * The model picker of every place a chat runs: search, Auto where the place
 * routes turns itself, then Recommended and All models, each row with its
 * maker's mark and the reasoning efforts the model offers.
 */
const ModelPicker = <TData,>({
  view: modelsView,
  options,
  benchmarks,
  lineageOf,
  recommendedHelp,
  auto,
  selectedValue,
  selectedReasoningEffort,
  onSelect,
  unavailable,
  failed,
  gone,
  open,
}: ModelPickerProps<TData>) => {
  const t = useTranslations();
  const format = useFormatter();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  // Remounted on every open (keyed by the host), so All models starts folded.
  const [allModelsExpanded, setAllModelsExpanded] = useState(false);
  const view = getModelPickerView({
    benchmarks,
    ...(lineageOf === undefined ? {} : { lineageOf }),
    options,
    query: search,
    selectedValue,
  });

  const renderRow = ({
    option,
    recommendation,
    tradeoff,
  }: ModelPickerEntry<ModelOption>) => (
    <ModelOptionRow
      key={option.value}
      onSelect={(reasoningEffort) => onSelect(option, reasoningEffort)}
      option={option}
      recommendation={recommendation}
      selected={selectedValue === option.value}
      selectedReasoningEffort={
        selectedValue === option.value ? selectedReasoningEffort : null
      }
      tradeoff={tradeoff}
    />
  );

  const radioValue = selectedValue ?? "";
  const visibleCount =
    view.type === "all"
      ? view.entries.length
      : view.recommended.length + view.others.length;
  const optionRows = (() => {
    if (modelsView.type === "error" && failed !== null) {
      return failed;
    }
    if (modelsView.type === "pending" || modelsView.type === "error") {
      return <QueryViewFeedback view={modelsView} />;
    }
    if (unavailable !== null) {
      return (
        <p className="text-muted-foreground px-2.5 py-2 text-xs text-pretty">
          {unavailable}
        </p>
      );
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
            {recommendedHelp}
          </div>
          {view.recommended.map(renderRow)}
        </MenuRadioGroup>
        <MenuItem
          aria-expanded={allModelsExpanded}
          closeOnClick={false}
          onClick={() => setAllModelsExpanded((expanded) => !expanded)}
        >
          <span className="text-muted-foreground flex-1">
            {t("chat.modelSelector.allModels")}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {format.number(visibleCount)}
          </span>
          <DirectionalIcon
            className={cn(
              "text-muted-foreground size-3.5 transition-transform duration-150",
              allModelsExpanded && "rotate-90",
            )}
            flip={!allModelsExpanded}
            icon={ChevronRightIcon}
          />
        </MenuItem>
        {allModelsExpanded && (
          <MenuRadioGroup
            aria-label={t("chat.modelSelector.allModels")}
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
      {auto !== null && (
        <>
          <MenuCheckboxItem
            checked={auto.checked}
            closeOnClick={false}
            onCheckedChange={auto.onCheckedChange}
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
        </>
      )}
      {modelsView.type === "items" && <QueryViewFeedback view={modelsView} />}
      {optionRows}
      {gone !== null && (
        <MenuRadioGroup value={radioValue}>
          <MenuRadioItem disabled value={gone.value}>
            <span className="flex min-w-0 flex-col py-0.5">
              <TruncatedText render={<BidiText as="span" />}>
                {gone.label}
              </TruncatedText>
              <span className="text-muted-foreground text-2xs">
                {t("chat.localRun.stateModelUnavailable")}
              </span>
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      )}
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
              <TruncatedText render={<BidiText as="span" />}>
                {option.displayName}
              </TruncatedText>
              {recommendation === "new" && (
                <span className="bg-muted text-muted-foreground text-2xs shrink-0 rounded-sm px-1.5 py-px font-medium">
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

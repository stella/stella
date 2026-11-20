import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type {
  ChatLocalRunTarget,
  ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { modelSelectionLabel } from "@stll/chat/model-selector";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CloudIcon, LaptopIcon } from "@stll/ui/icons";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import type { ProviderValue } from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import { ChatComposerChipsPending } from "@/components/chat/chat-composer-dock.pending";
import {
  ChatModelOptionsMenu,
  chatRunOnTarget,
  type ComposerModelsMenuProps,
} from "@/components/chat/chat-model-options-menu";
import { EFFORT_LABEL_KEY } from "@/components/chat/chat-model-options-menu.logic";
import {
  ChatRunTargetMenu,
  useCloudStartLabel,
  useLocalRunTargetStateLabel,
} from "@/components/chat/chat-run-target-menu";
import {
  CHAT_LOCAL_HARNESS_NAMES,
  type ChatCloudStart,
  localRunModelLabel,
  localRunTargetState,
} from "@/components/chat/chat-run-target-menu.logic";
import { LocalFolderApproval } from "@/components/chat/local-folder-approval";
import {
  localRunnersOptions,
  modelOptionsOptions,
} from "@/features/chat/queries";
import { useDesktopLaunch } from "@/features/chat/use-desktop-launch";
import { queryView } from "@/lib/query-view.logic";

/**
 * A button never shrinks by default, so a chip's truncating label could not
 * take effect and a narrow status row overflowed its column instead. The
 * chip's icon keeps its size (the button exempts its svg from shrinking).
 */
const STATUS_ROW_CHIP_SHRINK_CLASS = "min-w-0 shrink";

type ChatModelSelectorProps = {
  disabled?: boolean;
  models: ComposerModelsMenuProps;
};

/**
 * What the model chip shows: the choice, or `pending` while the label that
 * names it cannot be known yet (the stored choice, or the names the coding
 * agent or stella give its model, are still being read). A pending chip
 * holds the chip's box with a bar, so it never shows a label it then swaps.
 */
type TriggerView =
  | { type: "pending" }
  | {
      type: "ready";
      label: string;
      icon: React.ReactNode;
      /** An explicit choice reads as one; Auto stays quiet. */
      chosen: boolean;
    };

/**
 * The composer bar's two choices, from the composer's one choice owner:
 * where the chat runs (the cloud or the member's computer, with its coding
 * agent) and which model it uses there. A composer whose turns can run only
 * in the cloud, or a member who may not run turns on a computer, sees the
 * model chip alone.
 */
export const ChatComposerChips = ({
  disabled = false,
  models,
}: ChatModelSelectorProps) =>
  // Until the stored choice is read, neither chip can say what it is.
  models.state === "loading" ? (
    <ChatComposerChipsPending />
  ) : (
    <ChatComposerChipsReady disabled={disabled} models={models} />
  );

const ChatComposerChipsReady = ({
  disabled,
  models,
}: Required<ChatModelSelectorProps>) => (
  <>
    {models.runTarget.type === "choice" && (
      <ChatRunOnChip
        activeOrganizationId={models.activeOrganizationId}
        disabled={disabled || models.state === "loading"}
        onSelect={models.runTarget.select}
        selected={models.runTarget.selected}
        startedInCloud={models.runTarget.startedInCloud}
      />
    )}
    <ChatModelSelector disabled={disabled} models={models} />
  </>
);

type ChatRunOnChipProps = {
  activeOrganizationId: string;
  disabled: boolean;
  selected: ChatRunTarget;
  onSelect: (target: ChatRunTarget) => void;
  startedInCloud: ChatCloudStart | null;
};

/**
 * Where the chat runs: [Cloud], or [Your computer · Codex], with the linked
 * folder's name when the chat works in one, and why the computer or folder
 * cannot take a turn now when it says so (offline, signed out, or stella
 * desktop opening). A new chat that started in the cloud although the
 * member last chose their computer says why in its name and tooltip. Its
 * name for assistive technology says the place in full ("Runs on: Your
 * computer, Codex").
 */
const ChatRunOnChip = ({
  activeOrganizationId,
  disabled,
  selected,
  onSelect,
  startedInCloud,
}: ChatRunOnChipProps) => {
  const t = useTranslations();
  const stateLabel = useLocalRunTargetStateLabel();
  const cloudStartLabel = useCloudStartLabel();
  const desktop = useDesktopLaunch(activeOrganizationId);
  const [open, setOpen] = useState(false);
  const runnersView = queryView(
    useQuery(localRunnersOptions(activeOrganizationId)),
  );
  const readiness =
    runnersView.type === "items" ? runnersView.items : undefined;
  const readFailed = runnersView.type === "error";
  // A member who may not run turns on a computer has one place: no chip. A
  // failed read proves nothing, so the chip stays and says so.
  if (
    !readFailed &&
    readiness?.status !== "enabled" &&
    selected.kind !== "local"
  ) {
    return null;
  }
  const view = (() => {
    if (selected.kind !== "local") {
      const place = t("chat.runOn.cloud");
      return {
        label: place,
        name:
          startedInCloud === null
            ? place
            : t("chat.runOn.placeState", {
                place,
                state: cloudStartLabel(startedInCloud),
              }),
        icon: <CloudIcon aria-hidden="true" className="size-3.5" />,
      };
    }
    const harness = CHAT_LOCAL_HARNESS_NAMES[selected.harness];
    const targetState =
      readiness === undefined ? null : localRunTargetState(readiness, selected);
    // A failed read claims nothing about the agent; the model's own state
    // is the model chip's to say. An offline computer whose desktop is
    // opening says so instead.
    const placeState = () => {
      if (readFailed) {
        return t("chat.runOn.checkFailed");
      }
      if (targetState === null || targetState.type === "model_unavailable") {
        return null;
      }
      if (
        desktop.state.type === "opening" &&
        targetState.type === "harness" &&
        targetState.option.state === "offline"
      ) {
        return t("settings.account.desktopCardOpeningTitle");
      }
      return stateLabel(targetState);
    };
    const state = placeState();
    // A linked folder is named, never its path: the API knows only the name.
    const { folder } = selected;
    const selection =
      folder === undefined
        ? t("chat.runOn.localSelection", { harness })
        : t("chat.runOn.localFolderSelection", {
            harness,
            folder: folder.name,
          });
    const place =
      folder === undefined
        ? t("chat.runOn.localPlace", { harness })
        : t("chat.runOn.localFolderPlace", { harness, folder: folder.name });
    return {
      label:
        state === null
          ? selection
          : t("chat.localRun.selectionStateLabel", { selection, state }),
      name:
        state === null ? place : t("chat.runOn.placeState", { place, state }),
      icon: <LaptopIcon aria-hidden="true" className="size-3.5" />,
    };
  })();
  const name = t("chat.runOn.chipLabel", { place: view.name });

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <Button
            aria-label={name}
            // The chip gives way before the row overflows: it shrinks to its
            // truncated label, and in a narrow status row (a side pane) to its
            // icon alone. The aria-label and tooltip still name the place.
            className={STATUS_ROW_CHIP_SHRINK_CLASS}
            data-composer-chip="run-on"
            // Until the stored choice is known, nothing can be picked on it.
            disabled={disabled}
            size="xs"
            variant="muted"
          />
        }
        tooltip={name}
      >
        {view.icon}
        <TruncatedText
          className="max-w-44 @max-xl/composer-status:hidden"
          render={<BidiText as="span" />}
        >
          {view.label}
        </TruncatedText>
      </MenuTrigger>
      <MenuPopup align="start" className="w-80" side="top" sideOffset={6}>
        <ChatRunTargetMenu
          activeOrganizationId={activeOrganizationId}
          enabled={open}
          key={open ? "open" : "closed"}
          onSelect={onSelect}
          selected={selected}
          startedInCloud={startedInCloud}
        />
      </MenuPopup>
    </Menu>
  );
};

/**
 * The model chip: Auto routing or an explicit model and effort in the cloud,
 * or the model of the coding agent on the member's computer, with a model it
 * no longer offers marked so.
 */
export const ChatModelSelector = ({
  disabled = false,
  models,
}: ChatModelSelectorProps) => {
  const [open, setOpen] = useState(false);
  const [detailsRequested, setDetailsRequested] = useState(false);
  const selectedTarget = chatRunOnTarget(models.runTarget);
  const localTrigger = useLocalModelTrigger(
    models.activeOrganizationId,
    selectedTarget.kind === "local" ? selectedTarget : null,
  );
  // stella's models are read only for a thread that runs on them.
  const cloudTrigger = useCloudModelTrigger(
    models,
    localTrigger === null &&
      (open || detailsRequested || models.selectedModel !== null),
  );
  const trigger = localTrigger ?? cloudTrigger;
  const approval = selectedTarget.kind === "local" && (
    <LocalFolderApproval
      activeOrganizationId={models.activeOrganizationId}
      target={selectedTarget}
    />
  );
  if (trigger.type === "pending") {
    return (
      <>
        <ChatComposerChipsPending />
        {approval}
      </>
    );
  }

  return (
    <>
      <Menu onOpenChange={setOpen} open={open}>
        <MenuTrigger
          render={
            <Button
              aria-label={trigger.label}
              className={cn(
                STATUS_ROW_CHIP_SHRINK_CLASS,
                trigger.chosen
                  ? "bg-accent text-accent-foreground hover:text-accent-foreground gap-1.5"
                  : "text-muted-foreground hover:text-foreground gap-1.5",
              )}
              data-composer-chip="model"
              // Until the stored choice is known, nothing can be picked on it.
              disabled={disabled || models.state === "loading"}
              onFocus={() => setDetailsRequested(true)}
              onMouseEnter={() => setDetailsRequested(true)}
              size="xs"
              variant="ghost"
            />
          }
          tooltip={trigger.label}
        >
          {trigger.icon}
          <TruncatedText className="max-w-36" render={<BidiText as="span" />}>
            {trigger.label}
          </TruncatedText>
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="w-[min(32rem,calc(100vw-2rem))] max-w-(--available-width)"
          side="top"
          sideOffset={6}
        >
          <ChatModelOptionsMenu
            enabled={open}
            key={open ? "open" : "closed"}
            models={models}
            open={open}
          />
        </MenuPopup>
      </Menu>
      {approval}
    </>
  );
};

/**
 * The model a chat on the member's computer runs with, named as its coding
 * agent names it, with the reasoning effort when one is chosen, and marked
 * when the agent no longer offers it, which the API would refuse. `null` for
 * a chat in the cloud.
 */
const useLocalModelTrigger = (
  activeOrganizationId: string,
  target: ChatLocalRunTarget | null,
): TriggerView | null => {
  const t = useTranslations();
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled: target !== null,
    }),
  );
  if (target === null) {
    return null;
  }
  // The agent names its model once the member's computers are read; the
  // stored id until then would be a label the chip takes back.
  if (runnersView.type === "pending") {
    return { type: "pending" };
  }
  const readiness =
    runnersView.type === "items" ? runnersView.items : undefined;
  const modelLabel = localRunModelLabel(readiness, target) ?? target.model;
  const model =
    target.reasoningEffort === null
      ? modelLabel
      : t("chat.modelSelector.selectionLabel", {
          model: modelLabel,
          effort: t(EFFORT_LABEL_KEY[target.reasoningEffort]),
        });
  const gone =
    readiness !== undefined &&
    localRunTargetState(readiness, target).type === "model_unavailable";
  return {
    type: "ready",
    label: gone
      ? t("chat.localRun.selectionStateLabel", {
          selection: model,
          state: t("chat.localRun.stateModelUnavailable"),
        })
      : model,
    icon: null,
    chosen: false,
  };
};

/** Auto, or the stella model and effort the thread uses. */
const useCloudModelTrigger = (
  {
    activeOrganizationId,
    selectedModel,
    selectedReasoningEffort,
  }: ComposerModelsMenuProps,
  enabled: boolean,
): TriggerView => {
  const t = useTranslations();
  const modelsQuery = useQuery({
    ...modelOptionsOptions(activeOrganizationId),
    enabled,
  });
  const modelsView = queryView(modelsQuery);
  const selectedOption =
    modelsView.type === "items"
      ? modelsView.items.options.find(
          (option) => option.value === selectedModel,
        )
      : undefined;
  const chosen = selectedModel !== null;
  if (selectedOption) {
    return {
      type: "ready",
      label: modelSelectionLabel({
        defaultEffortLabel: t(
          "chat.modelSelector.effortValues.providerDefault",
        ),
        displayName: selectedOption.displayName,
        formatSelectionLabel: ({ effort, model }) =>
          t("chat.modelSelector.selectionLabel", { effort, model }),
        providerDefaultEffort: selectedOption.defaultReasoningEffort,
        reasoningEffort: selectedReasoningEffort,
        translateEffort: (effort) => t(EFFORT_LABEL_KEY[effort]),
      }),
      icon: <ModelTriggerIcon provider={selectedOption.iconProvider} />,
      chosen,
    };
  }
  if (selectedModel === null) {
    return {
      type: "ready",
      label: t("chat.modelSelector.autoLabel"),
      icon: null,
      chosen,
    };
  }
  switch (modelsView.type) {
    // An explicit model is named once stella's models are read; until then
    // the chip holds its box rather than saying "Loading".
    case "pending":
      return { type: "pending" };
    case "error":
      return {
        type: "ready",
        label: t("common.somethingWentWrong"),
        icon: null,
        chosen,
      };
    case "empty":
    case "items":
      return { type: "ready", label: selectedModel, icon: null, chosen };
    default:
      modelsView satisfies never;
      return panic("Unhandled model selector query state");
  }
};

const ModelTriggerIcon = ({ provider }: { provider: ProviderValue }) => (
  <AIProviderIcon aria-hidden="true" className="size-3.5" provider={provider} />
);

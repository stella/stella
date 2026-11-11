import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ChatLocalRunTarget } from "@stll/api-contract/chat-run-target";
import { modelSelectionLabel } from "@stll/chat/model-selector";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { LaptopIcon } from "@stll/ui/icons";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import type { ProviderValue } from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import {
  CHAT_MODEL_MENU_POPUP_CLASS_NAME,
  ChatModelOptionsMenu,
  chatRunOnTarget,
  type ComposerModelsMenuProps,
  EFFORT_LABEL_KEY,
} from "@/components/chat/chat-model-options-menu";
import {
  CHAT_LOCAL_HARNESS_NAMES,
  localRunModelLabel,
} from "@/components/chat/chat-run-target-menu.logic";
import {
  localRunnersOptions,
  modelOptionsOptions,
} from "@/features/chat/queries";
import { queryView } from "@/lib/query-view.logic";

type ChatModelSelectorProps = {
  disabled?: boolean;
  models: ComposerModelsMenuProps;
};

type TriggerView = {
  label: string;
  icon: React.ReactNode;
  /** An explicit choice reads as one; Auto stays quiet. */
  chosen: boolean;
};

/**
 * Auto routing plus explicit model/effort selection for one thread, or the
 * harness and model of a thread that runs on the member's computer.
 */
export const ChatModelSelector = ({
  disabled = false,
  models,
}: ChatModelSelectorProps) => {
  const [open, setOpen] = useState(false);
  const [detailsRequested, setDetailsRequested] = useState(false);
  const selectedTarget = chatRunOnTarget(models.runTarget);
  const localTrigger = useLocalRunTrigger(
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

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <Button
            aria-label={trigger.label}
            className={cn(
              trigger.chosen
                ? "bg-accent text-accent-foreground hover:text-accent-foreground gap-1.5"
                : "text-muted-foreground hover:text-foreground gap-1.5",
            )}
            disabled={disabled}
            onFocus={() => setDetailsRequested(true)}
            onMouseEnter={() => setDetailsRequested(true)}
            size="xs"
            variant="ghost"
          />
        }
        tooltip={trigger.label}
      >
        {trigger.icon}
        <BidiText as="span" className="max-w-36 truncate">
          {trigger.label}
        </BidiText>
      </MenuTrigger>
      <MenuPopup
        align="start"
        className={CHAT_MODEL_MENU_POPUP_CLASS_NAME}
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
  );
};

/**
 * The harness and model a thread on the member's computer runs with, named
 * as the harness reports the model; `null` for a thread on stella's models.
 */
const useLocalRunTrigger = (
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
  const model =
    localRunModelLabel(
      runnersView.type === "items" ? runnersView.items : undefined,
      target,
    ) ?? target.model;
  return {
    label: t("chat.localRun.selectionLabel", {
      harness: CHAT_LOCAL_HARNESS_NAMES[target.harness],
      model,
    }),
    icon: <LaptopIcon aria-hidden="true" className="size-3.5" />,
    chosen: true,
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
  const label = (() => {
    if (selectedOption) {
      return modelSelectionLabel({
        defaultEffortLabel: t(
          "chat.modelSelector.effortValues.providerDefault",
        ),
        displayName: selectedOption.displayName,
        formatSelectionLabel: ({ effort, model }) =>
          t("chat.modelSelector.selectionLabel", { effort, model }),
        providerDefaultEffort: selectedOption.defaultReasoningEffort,
        reasoningEffort: selectedReasoningEffort,
        translateEffort: (effort) => t(EFFORT_LABEL_KEY[effort]),
      });
    }
    if (selectedModel === null) {
      return t("chat.modelSelector.autoLabel");
    }
    switch (modelsView.type) {
      case "pending":
        return t("common.loading");
      case "error":
        return t("common.somethingWentWrong");
      case "empty":
      case "items":
        return selectedModel;
      default:
        modelsView satisfies never;
        return panic("Unhandled model selector query state");
    }
  })();
  return {
    label,
    icon: selectedOption ? (
      <ModelTriggerIcon provider={selectedOption.iconProvider} />
    ) : null,
    chosen: selectedModel !== null,
  };
};

const ModelTriggerIcon = ({ provider }: { provider: ProviderValue }) => (
  <AIProviderIcon aria-hidden="true" className="size-3.5" provider={provider} />
);

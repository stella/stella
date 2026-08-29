import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { modelSelectionLabel } from "@stll/chat/model-selector";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import type { ProviderValue } from "@/components/ai-config-role-models.logic";
import { AIProviderIcon } from "@/components/ai-provider-icons";
import {
  CHAT_MODEL_MENU_POPUP_CLASS_NAME,
  ChatModelOptionsMenu,
  EFFORT_LABEL_KEY,
  type ComposerModelsMenuProps,
} from "@/components/chat/chat-model-options-menu";
import { modelOptionsOptions } from "@/features/chat/queries";

type ChatModelSelectorProps = {
  disabled?: boolean;
  models: ComposerModelsMenuProps;
};

/** Auto routing plus explicit model/effort selection for one thread. */
export const ChatModelSelector = ({
  disabled = false,
  models,
}: ChatModelSelectorProps) => {
  const t = useTranslations();
  const { activeOrganizationId, selectedModel, selectedReasoningEffort } =
    models;
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
        formatSelectionLabel: ({ effort, model }) =>
          t("chat.modelSelector.selectionLabel", { effort, model }),
        providerDefaultEffort: selectedOption.defaultReasoningEffort,
        reasoningEffort: selectedReasoningEffort,
        translateEffort: (effort) => t(EFFORT_LABEL_KEY[effort]),
      })
    : t("chat.modelSelector.autoLabel");

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <Button
            aria-label={triggerLabel}
            className={cn(
              selectedModel === null
                ? "text-muted-foreground hover:text-foreground gap-1.5"
                : "bg-accent text-accent-foreground hover:text-accent-foreground gap-1.5",
            )}
            disabled={disabled}
            onFocus={() => setDetailsRequested(true)}
            onMouseEnter={() => setDetailsRequested(true)}
            size="xs"
            variant="ghost"
          />
        }
        tooltip={triggerLabel}
      >
        {selectedOption && (
          <ModelTriggerIcon provider={selectedOption.iconProvider} />
        )}
        <BidiText as="span" className="max-w-36 truncate">
          {triggerLabel}
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

const ModelTriggerIcon = ({ provider }: { provider: ProviderValue }) => (
  <AIProviderIcon aria-hidden="true" className="size-3.5" provider={provider} />
);

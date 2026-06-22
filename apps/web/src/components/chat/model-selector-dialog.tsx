import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stll/ui/components/button";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { cn } from "@stll/ui/lib/utils";

import {
  encodeModelSelection,
  MODEL_OPTIONS_BY_PROVIDER,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
} from "@/components/ai-config-role-models.logic";
import { useDevStore } from "@/lib/dev-store";
import { useModelSelectorStore } from "@/lib/model-selector-store";

const CHAT_MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default (chat role)" },
  ...PROVIDER_KEYS.flatMap((provider) =>
    MODEL_OPTIONS_BY_PROVIDER[provider].map((modelId) => ({
      value: encodeModelSelection({ provider, modelId }),
      label: `${PROVIDER_LABELS[provider]} · ${modelId}`,
    })),
  ),
];

export function ModelSelectorDialog() {
  const t = useTranslations();
  const { isOpen, close } = useModelSelectorStore();
  const dev = useDevStore(
    useShallow((s) => ({
      chatModelId: s.chatModelId,
      setChatModelId: s.setChatModelId,
    })),
  );

  const handleSelectModel = (value: string) => {
    dev.setChatModelId(value || null);
    close();
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open={isOpen}
    >
      <DialogPopup
        className="bg-background border-border w-full max-w-md rounded-2xl border p-6 shadow-2xl"
        initialFocus={false}
        showCloseButton
      >
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-foreground text-lg font-semibold tracking-tight">
              {t("chat.modelSelector.title")}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("chat.modelSelector.description")}
            </p>
          </div>

          <div
            className="max-h-80 space-y-1.5 overflow-y-auto pe-1"
            style={{ scrollbarGutter: "stable" }}
          >
            {CHAT_MODELS.map((model) => {
              const isActive = (dev.chatModelId ?? "") === model.value;
              return (
                <Button
                  id={`model-option-${model.value || "default"}`}
                  key={model.value}
                  className={cn(
                    "w-full justify-start rounded-xl px-3 py-2 text-start font-normal transition-all duration-200",
                    isActive
                      ? "bg-primary text-primary-foreground hover:bg-primary/90 font-medium shadow-sm"
                      : "hover:bg-accent hover:text-accent-foreground text-foreground",
                  )}
                  onClick={() => handleSelectModel(model.value)}
                  variant={isActive ? "default" : "ghost"}
                >
                  <span className="truncate text-sm">
                    {model.value === ""
                      ? t("chat.modelSelector.defaultLabel")
                      : model.label}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

import { useCallback } from "react";

import {
  BracesIcon,
  GitBranchIcon,
  RepeatIcon,
  SparklesIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";

import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";

type SuggestionKind = "placeholder" | "conditional" | "repeat";

export const TemplateAssistantPanel = () => {
  const t = useTranslations();
  const { templateName, selectedText, messages, addMessage } =
    useTemplateAssistantStore(
      useShallow((s) => ({
        templateName: s.templateName,
        selectedText: s.selectedText,
        messages: s.messages,
        addMessage: s.addMessage,
      })),
    );

  const getMockResponse = useCallback(
    (kind: SuggestionKind): string => {
      if (kind === "conditional") {
        return t("rightPanel.mockResponseConditional");
      }
      if (kind === "repeat") {
        return t("rightPanel.mockResponseRepeat");
      }
      return t("rightPanel.mockResponsePlaceholder");
    },
    [t],
  );

  const handleSuggestion = useCallback(
    (kind: SuggestionKind) => {
      const userText = selectedText ? `"${selectedText}" → ${kind}` : kind;

      addMessage({
        id: nanoid(),
        role: "user",
        text: userText,
      });

      addMessage({
        id: nanoid(),
        role: "assistant",
        text: getMockResponse(kind),
      });
    },
    [selectedText, addMessage, getMockResponse],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SparklesIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">
          {t("rightPanel.templateAssistant")}
        </span>
      </div>

      {/* Template name */}
      {templateName && (
        <div className="border-b px-3 py-2">
          <p className="text-muted-foreground truncate text-xs">
            {templateName}
          </p>
        </div>
      )}

      {/* Selected text */}
      {selectedText && (
        <div className="border-b px-3 py-2.5">
          <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
            {t("rightPanel.selectedText")}
          </p>
          <p className="bg-muted/50 rounded px-2 py-1.5 text-xs">
            {selectedText}
          </p>
        </div>
      )}

      {/* Suggestion buttons */}
      {selectedText && (
        <div className="border-b p-3">
          <p className="text-muted-foreground mb-2 text-xs">
            {t("rightPanel.whatToDo")}
          </p>
          <div className="flex flex-col gap-1.5">
            <Button
              className="justify-start"
              onClick={() => handleSuggestion("placeholder")}
              size="sm"
              variant="ghost"
            >
              <BracesIcon className="size-3.5" />
              {t("rightPanel.convertToPlaceholder")}
            </Button>
            <Button
              className="justify-start"
              onClick={() => handleSuggestion("conditional")}
              size="sm"
              variant="ghost"
            >
              <GitBranchIcon className="size-3.5" />
              {t("rightPanel.addConditional")}
            </Button>
            <Button
              className="justify-start"
              onClick={() => handleSuggestion("repeat")}
              size="sm"
              variant="ghost"
            >
              <RepeatIcon className="size-3.5" />
              {t("rightPanel.repeatForEach")}
            </Button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3">
        {messages.length === 0 && !selectedText && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <SparklesIcon className="size-8 opacity-20" />
            <p className="text-muted-foreground text-xs">
              {t("rightPanel.comingSoon")}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            className={`mb-2 rounded-lg px-3 py-2 text-xs ${
              msg.role === "user" ? "bg-muted ms-4" : "bg-primary/5 me-4"
            }`}
            key={msg.id}
          >
            {msg.text}
          </div>
        ))}
      </div>

      {/* Disabled input + disclaimer */}
      <div className="border-t p-3">
        <Input
          className="mb-2 text-xs"
          disabled
          placeholder={t("rightPanel.comingSoon")}
        />
        <p className="text-muted-foreground text-[10px]">
          {t("rightPanel.mockDisclaimer")}
        </p>
      </div>
    </div>
  );
};

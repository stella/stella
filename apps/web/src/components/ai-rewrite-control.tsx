import { useId, useState } from "react";

import { ChevronDownIcon, Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Label } from "@stll/ui/components/label";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { Textarea } from "@stll/ui/components/textarea";
import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";

const MAX_CUSTOM_INSTRUCTION_LENGTH = 2000;

const AI_REWRITE_PRESETS = [
  {
    id: "polish",
    instruction:
      "Polish the writing so it is clear and professional while preserving its meaning and language.",
  },
  {
    id: "concise",
    instruction:
      "Make the writing more concise without removing material facts or changing its meaning.",
  },
  {
    id: "clarify",
    instruction:
      "Improve clarity and specificity without inventing facts or changing the meaning.",
  },
  {
    id: "formal",
    instruction:
      "Use a more formal, professional tone while preserving the meaning and language.",
  },
] as const;

type AiRewritePresetId = (typeof AI_REWRITE_PRESETS)[number]["id"];

const PRESET_LABEL_KEYS = {
  clarify: "ai.rewritePresets.clarify",
  concise: "ai.rewritePresets.concise",
  formal: "ai.rewritePresets.formal",
  polish: "ai.rewritePresets.polish",
} as const satisfies Record<AiRewritePresetId, TranslationKey>;

type AiRewriteControlProps = {
  className?: string | undefined;
  disabled?: boolean | undefined;
  isPending?: boolean | undefined;
  label?: string | undefined;
  onRewrite: (instruction: string) => void;
};

/**
 * The shared prose-rewrite affordance. The primary wand applies the default
 * polish preset; the adjacent menu exposes every preset and a bounded custom
 * instruction. Domain-specific request, privacy, and apply semantics stay
 * behind `onRewrite`.
 */
export const AiRewriteControl = ({
  className,
  disabled = false,
  isPending = false,
  label,
  onRewrite,
}: AiRewriteControlProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");
  const customInstructionId = useId();
  const actionLabel = label ?? t("ai.editWithAI");
  const unavailable = disabled || isPending;

  const runRewrite = (instruction: string) => {
    if (unavailable) {
      return;
    }
    setOpen(false);
    onRewrite(instruction);
  };

  return (
    <div
      className={cn("inline-flex shrink-0 items-center", className)}
      data-slot="ai-rewrite-control"
    >
      <Button
        aria-label={actionLabel}
        className="rounded-e-none"
        disabled={unavailable}
        onClick={() => runRewrite(AI_REWRITE_PRESETS[0].instruction)}
        size="icon-sm"
        tooltip={actionLabel}
        type="button"
        variant="ghost"
      >
        {isPending ? (
          <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <WandSparklesIcon aria-hidden className="size-3.5" />
        )}
      </Button>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={t("ai.chooseRewriteInstruction")}
              className="-ms-px rounded-s-none px-1"
              disabled={unavailable}
              size="icon-sm"
              tooltip={t("ai.chooseRewriteInstruction")}
              type="button"
              variant="ghost"
            />
          }
        >
          <ChevronDownIcon aria-hidden className="size-3" />
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-80" side="bottom">
          <div className="flex flex-col gap-1">
            {AI_REWRITE_PRESETS.map((preset) => (
              <Button
                className="w-full justify-start font-normal"
                key={preset.id}
                onClick={() => runRewrite(preset.instruction)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t(PRESET_LABEL_KEYS[preset.id])}
              </Button>
            ))}
            <div className="bg-border my-1 h-px" />
            <Label
              className="text-muted-foreground px-1 text-xs font-medium"
              htmlFor={customInstructionId}
            >
              {t("ai.customRewriteInstruction")}
            </Label>
            <Textarea
              id={customInstructionId}
              maxLength={MAX_CUSTOM_INSTRUCTION_LENGTH}
              onChange={(event) =>
                setCustomInstruction(event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter" &&
                  customInstruction.trim().length > 0
                ) {
                  event.preventDefault();
                  runRewrite(customInstruction.trim());
                }
              }}
              placeholder={t("ai.refinePlaceholder")}
              rows={3}
              value={customInstruction}
            />
            <Button
              className="mt-1 self-end"
              disabled={customInstruction.trim().length === 0}
              onClick={() => runRewrite(customInstruction.trim())}
              size="sm"
              type="button"
            >
              <WandSparklesIcon aria-hidden className="size-3.5" />
              {t("ai.editWithAI")}
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
};

import type { ComponentProps } from "react";

import { ArrowUpIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

/**
 * Full composer-action state. The button — not the caller — decides
 * whether it is Send, Stop, or Retry, so a surface structurally cannot
 * compose "Send next to Stop": there is no mode prop to request, and
 * while a turn is generating (with a stop handler wired) the single
 * button always morphs to Stop. Sending while generating happens via
 * Enter/submit queueing in the composer, not via a second button.
 */
export type ChatComposerActionState = {
  /** True while a turn is streaming. */
  isGenerating: boolean;
  /** Whether the current draft is sendable (gates the Send state only). */
  canSend: boolean;
  onSend: () => void;
  /**
   * Abort the live turn. While `isGenerating` this makes the button
   * morph to Stop; without it the button stays a (disabled) Send.
   */
  onStop?: (() => void) | undefined;
  /**
   * Post-stop retry. Owners pass it only while the retry offer stands
   * (stopped turn, empty composer); it is ignored while generating.
   */
  onRetry?: (() => void) | undefined;
};

type ChatComposerActionMode = "send" | "stop" | "retry";

/**
 * The one place the send/stop/retry decision lives. Exported so a
 * caller rendering a matching tooltip labels the same state the button
 * shows — it must never re-derive the mode with its own logic.
 */
export const resolveChatComposerAction = ({
  isGenerating,
  onStop,
  onRetry,
}: Pick<
  ChatComposerActionState,
  "isGenerating" | "onStop" | "onRetry"
>): ChatComposerActionMode => {
  if (isGenerating && onStop !== undefined) {
    return "stop";
  }
  if (!isGenerating && onRetry !== undefined) {
    return "retry";
  }
  return "send";
};

type ChatComposerActionButtonProps = ChatComposerActionState & {
  className?: string;
  iconClassName?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
};

export const ChatComposerActionButton = (
  props: ChatComposerActionButtonProps,
) => {
  const t = useTranslations();
  const mode = resolveChatComposerAction(props);
  const label = (() => {
    switch (mode) {
      case "send":
        return t("chat.sendPrompt");
      case "stop":
        return t("chat.stopResponse");
      case "retry":
        return t("common.retry");
      default:
        mode satisfies never;
        return "";
    }
  })();
  const enabled = mode !== "send" || props.canSend;

  const handleClick = () => {
    switch (mode) {
      case "send":
        props.onSend();
        return;
      case "stop":
        props.onStop?.();
        return;
      case "retry":
        props.onRetry?.();
        return;
      default:
        mode satisfies never;
    }
  };

  const { className, iconClassName, size = "icon-sm", variant } = props;

  return (
    <Button
      aria-label={label}
      // Canonical composer send/stop/retry look, baked in so every chat
      // surface renders the identical round, foreground-filled button
      // without repeating the styling at each call site. Callers pass
      // only state + handlers; `className` remains available for
      // positioning overrides and wins via twMerge if it must.
      className={cn(
        // `size-7` pins the circle to the ComposerPlusMenu trigger's
        // diameter at every breakpoint (`icon-sm` alone is 32px below
        // `sm`), so a composer row's two round ends always match.
        "bg-foreground text-background hover:bg-foreground/90 size-7 shrink-0 rounded-full",
        className,
        !enabled && "opacity-50",
      )}
      disabled={!enabled}
      onClick={handleClick}
      size={size}
      tooltip={false}
      type="button"
      variant={variant}
    >
      <span
        aria-hidden="true"
        className={cn("pointer-events-none relative size-3.5", iconClassName)}
      >
        <SquareIcon
          className={cn(
            "absolute inset-0 mx-0! size-full transition-[opacity,transform] duration-150 ease-out",
            mode === "stop" ? "scale-100 opacity-100" : "scale-75 opacity-0",
          )}
        />
        <RotateCcwIcon
          className={cn(
            "absolute inset-0 mx-0! size-full transition-[opacity,transform] duration-150 ease-out",
            mode === "retry" ? "scale-100 opacity-100" : "scale-75 opacity-0",
          )}
        />
        <ArrowUpIcon
          className={cn(
            "absolute inset-0 mx-0! size-full transition-[opacity,transform] duration-150 ease-out",
            mode === "send" ? "scale-100 opacity-100" : "scale-75 opacity-0",
          )}
        />
      </span>
    </Button>
  );
};

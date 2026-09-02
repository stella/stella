import type { ComponentProps } from "react";

import { ArrowUpIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  resolveChatComposerAction,
  type ChatComposerActionState,
} from "@stll/chat/composer";
import { Button } from "@stll/ui/button";
import {
  COMPOSER_CONTROL_BUTTON_SIZE,
  COMPOSER_SEND_BUTTON_CLASS,
} from "@stll/ui/composer";
import { cn } from "@stll/ui/utils";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";

type ChatComposerActionButtonProps = ChatComposerActionState & {
  className?: string;
  guideAnchorsEnabled?: boolean;
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

  const {
    className,
    iconClassName,
    size = COMPOSER_CONTROL_BUTTON_SIZE,
    variant,
  } = props;

  return (
    <Button
      {...guideAnchor(
        GUIDE_ANCHORS.chatSend,
        props.guideAnchorsEnabled ?? false,
      )}
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
        COMPOSER_SEND_BUTTON_CLASS,
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

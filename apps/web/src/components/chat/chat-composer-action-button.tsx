import type { ComponentProps } from "react";

import { ArrowUpIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

type ChatComposerActionButtonBaseProps = {
  className?: string;
  iconClassName?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
};

type ChatComposerActionButtonProps = ChatComposerActionButtonBaseProps &
  (
    | {
        canSend: boolean;
        mode: "send";
        onSend: () => void;
      }
    | {
        mode: "stop";
        onStop: () => void;
      }
    | {
        mode: "retry";
        onRetry: () => void;
      }
  );

export const ChatComposerActionButton = (
  props: ChatComposerActionButtonProps,
) => {
  const t = useTranslations();
  const label = (() => {
    switch (props.mode) {
      case "send":
        return t("chat.sendPrompt");
      case "stop":
        return t("chat.stopResponse");
      case "retry":
        return t("common.retry");
      default:
        props satisfies never;
        return "";
    }
  })();
  const canSend = props.mode !== "send" || props.canSend;

  const handleClick = () => {
    switch (props.mode) {
      case "send":
        props.onSend();
        return;
      case "stop":
        props.onStop();
        return;
      case "retry":
        props.onRetry();
        return;
      default:
        props satisfies never;
    }
  };

  const { className, iconClassName, size, variant } = props;

  return (
    <Button
      aria-label={label}
      className={cn(className, !canSend && "opacity-50")}
      disabled={!canSend}
      onClick={handleClick}
      size={size}
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
            props.mode === "stop"
              ? "scale-100 opacity-100"
              : "scale-75 opacity-0",
          )}
        />
        <RotateCcwIcon
          className={cn(
            "absolute inset-0 mx-0! size-full transition-[opacity,transform] duration-150 ease-out",
            props.mode === "retry"
              ? "scale-100 opacity-100"
              : "scale-75 opacity-0",
          )}
        />
        <ArrowUpIcon
          className={cn(
            "absolute inset-0 mx-0! size-full transition-[opacity,transform] duration-150 ease-out",
            props.mode === "send"
              ? "scale-100 opacity-100"
              : "scale-75 opacity-0",
          )}
        />
      </span>
    </Button>
  );
};

import { forwardRef, useRef } from "react";
import type { ComponentProps } from "react";

import { ArrowUpIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { containedHandler } from "@stll/ui/hooks/use-contained-handler";
import { cn } from "@stll/ui/lib/utils";

import { composeRefs } from "@/lib/slot";

type ChatComposerActionButtonBaseProps = {
  className?: string;
  iconClassName?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
};

type ButtonForwardProps = Omit<
  ComponentProps<typeof Button>,
  | "aria-label"
  | "children"
  | "className"
  | "disabled"
  | "onClick"
  | "size"
  | "variant"
>;

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
  ) &
  ButtonForwardProps;

export const ChatComposerActionButton = forwardRef<
  HTMLButtonElement,
  ChatComposerActionButtonProps
>((props, ref) => {
  const t = useTranslations();
  const buttonRef = useRef<HTMLButtonElement>(null);
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
  const buttonProps = buttonForwardProps(props);

  return (
    <Button
      {...buttonProps}
      aria-label={label}
      className={cn(className, !canSend && "opacity-50")}
      disabled={!canSend}
      onClick={containedHandler(buttonRef, handleClick)}
      ref={composeRefs(buttonRef, ref)}
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
});

ChatComposerActionButton.displayName = "ChatComposerActionButton";

const buttonForwardProps = (
  props: ChatComposerActionButtonProps,
): ButtonForwardProps => {
  if (props.mode === "send") {
    const {
      canSend: _canSend,
      className: _className,
      iconClassName: _iconClassName,
      mode: _mode,
      onSend: _onSend,
      size: _size,
      variant: _variant,
      ...buttonProps
    } = props;
    return buttonProps;
  }

  if (props.mode === "stop") {
    const {
      className: _className,
      iconClassName: _iconClassName,
      mode: _mode,
      onStop: _onStop,
      size: _size,
      variant: _variant,
      ...buttonProps
    } = props;
    return buttonProps;
  }

  const {
    className: _className,
    iconClassName: _iconClassName,
    mode: _mode,
    onRetry: _onRetry,
    size: _size,
    variant: _variant,
    ...buttonProps
  } = props;
  return buttonProps;
};

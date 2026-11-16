import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  type ChatComposerActionState,
  resolveChatComposerAction,
} from "@stll/chat/composer";
import { Button } from "@stll/ui/button";
import { ArrowUpIcon, RotateCcwIcon, SquareIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";

type ChatComposerActionButtonProps = ChatComposerActionState & {
  /** A stop was asked for and the turn has not ended yet: the button says
   *  so and takes no second click. */
  stopping?: boolean;
  className?: string;
  guideAnchorsEnabled?: boolean;
  iconClassName?: string;
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
        return props.stopping === true
          ? t("chat.stopping")
          : t("chat.stopResponse");
      case "retry":
        return t("common.retry");
      default:
        mode satisfies never;
        return panic(`Unhandled mode: ${String(mode)}`);
    }
  })();
  const enabled =
    mode === "stop"
      ? props.stopping !== true
      : mode !== "send" || props.canSend;

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
        panic(`Unhandled mode: ${String(mode)}`);
    }
  };

  const { className, iconClassName } = props;

  return (
    <Button
      {...guideAnchor(
        GUIDE_ANCHORS.chatSend,
        props.guideAnchorsEnabled ?? false,
      )}
      aria-busy={mode === "stop" && props.stopping === true ? true : undefined}
      aria-label={label}
      className={cn(className, !enabled && "opacity-50")}
      disabled={!enabled}
      onClick={handleClick}
      size="icon-round"
      tooltip={false}
      type="button"
      variant="composer"
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

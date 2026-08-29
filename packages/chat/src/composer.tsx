import type { ReactNode } from "react";

import { ArrowUpIcon, RotateCcwIcon, SquareIcon } from "lucide-react";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

export type ChatComposerActionState = {
  canSend: boolean;
  isGenerating: boolean;
  onRetry?: (() => void) | undefined;
  onSend: () => void;
  onStop?: (() => void) | undefined;
};

export type ChatComposerActionMode = "retry" | "send" | "stop";

export const resolveChatComposerAction = ({
  isGenerating,
  onRetry,
  onStop,
}: Pick<
  ChatComposerActionState,
  "isGenerating" | "onRetry" | "onStop"
>): ChatComposerActionMode => {
  if (isGenerating && onStop !== undefined) {
    return "stop";
  }
  if (!isGenerating && onRetry !== undefined) {
    return "retry";
  }
  return "send";
};

export type ChatComposerLabels = Record<ChatComposerActionMode, string>;

export const ChatComposerAction = ({
  canSend,
  className,
  isGenerating,
  labels,
  onRetry,
  onSend,
  onStop,
}: ChatComposerActionState & {
  className?: string | undefined;
  labels: ChatComposerLabels;
}) => {
  const mode = resolveChatComposerAction({ isGenerating, onRetry, onStop });
  const disabled = mode === "send" && !canSend;
  const onClick = (): void => {
    switch (mode) {
      case "send":
        onSend();
        return;
      case "stop":
        onStop?.();
        return;
      case "retry":
        onRetry?.();
        return;
      default:
        mode satisfies never;
    }
  };

  return (
    <Button
      aria-label={labels[mode]}
      className={cn(
        "bg-foreground text-background hover:bg-foreground/90 size-7 shrink-0 rounded-full",
        className,
      )}
      disabled={disabled}
      onClick={onClick}
      size="icon-sm"
      tooltip={false}
      type="button"
    >
      {mode === "send" && (
        <ArrowUpIcon aria-hidden="true" className="size-3.5" />
      )}
      {mode === "stop" && (
        <SquareIcon aria-hidden="true" className="size-3.5" />
      )}
      {mode === "retry" && (
        <RotateCcwIcon aria-hidden="true" className="size-3.5" />
      )}
    </Button>
  );
};

export type ChatComposerProps = ChatComposerActionState & {
  children: ReactNode;
  className?: string | undefined;
  labels: ChatComposerLabels;
  leading?: ReactNode | undefined;
  status?: ReactNode | undefined;
};

/**
 * Layout-only composer shell for rich editors. `children` is deliberately a
 * host-owned editor slot, so TipTap, ProseMirror, native inputs, and mobile
 * editors can share send/stop/retry behavior without copying shell chrome.
 */
export const ChatComposer = ({
  children,
  className,
  labels,
  leading,
  status,
  ...action
}: ChatComposerProps) => (
  <section className={cn("flex flex-col gap-1.5", className)}>
    <div className="border-input bg-background flex min-w-0 items-end gap-2 rounded-xl border p-2">
      {leading}
      <div className="min-w-0 flex-1">{children}</div>
      <ChatComposerAction {...action} labels={labels} />
    </div>
    {status}
  </section>
);

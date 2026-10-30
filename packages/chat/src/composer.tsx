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

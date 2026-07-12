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

export type ChatComposerActionMode = "send" | "stop" | "retry";

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

import * as v from "valibot";

const CHANNEL_NAME = "mcp-oauth";

export const mcpOAuthOutcomeSchema = v.union([
  v.strictObject({
    status: v.literal("connected"),
  }),
  v.strictObject({
    status: v.literal("error"),
    reason: v.string(),
  }),
]);

export type McpOAuthOutcome = v.InferOutput<typeof mcpOAuthOutcomeSchema>;

export function broadcastMcpOAuthOutcome(outcome: McpOAuthOutcome): void {
  // Prefer BroadcastChannel (covers same-origin tabs even when COOP
  // severs `window.opener`). Fall back to `opener.postMessage` only
  // when BroadcastChannel is unavailable, so the subscriber on the
  // opener page receives the outcome exactly once.
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    // BroadcastChannel.postMessage takes no targetOrigin; messages are
    // confined to the same origin by the browser's BroadcastChannel
    // contract.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage(outcome);
    channel.close();
    return;
  }

  // SAFETY: lib.dom types `window.opener` as `any` because the
  // opener may be a Window from any origin. We post to our own
  // origin only, so narrowing to the postMessage surface is safe.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const opener = window.opener as Pick<Window, "postMessage"> | null;
  if (opener !== null) {
    opener.postMessage(outcome, window.location.origin);
  }
}

export function subscribeToMcpOAuthOutcome(
  handler: (outcome: McpOAuthOutcome) => void,
): () => void {
  const onMessage = (event: MessageEvent) => {
    const result = v.safeParse(mcpOAuthOutcomeSchema, event.data);
    if (result.success) {
      handler(result.output);
    }
  };

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CHANNEL_NAME);
  channel?.addEventListener("message", onMessage);

  const onWindowMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
      return;
    }
    onMessage(event);
  };
  window.addEventListener("message", onWindowMessage);

  return () => {
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    window.removeEventListener("message", onWindowMessage);
  };
}

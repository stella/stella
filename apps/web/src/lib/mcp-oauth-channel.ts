import * as v from "valibot";

const CHANNEL_NAME = "mcp-oauth";
const MESSAGE_KIND = "stll.mcp-oauth";

// Wire schema carries a `kind` discriminator so the global
// `window.message` listener on the opener page can't pick up
// unrelated messages that happen to share `status`. Callers only
// see the public `McpOAuthOutcome` (without `kind`).
const mcpOAuthMessageSchema = v.union([
  v.strictObject({
    kind: v.literal(MESSAGE_KIND),
    status: v.literal("connected"),
  }),
  v.strictObject({
    kind: v.literal(MESSAGE_KIND),
    status: v.literal("error"),
    reason: v.string(),
  }),
]);

export type McpOAuthOutcome =
  | { status: "connected" }
  | { status: "error"; reason: string };

export function broadcastMcpOAuthOutcome(outcome: McpOAuthOutcome): void {
  const message = { kind: MESSAGE_KIND, ...outcome };

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
    channel.postMessage(message);
    channel.close();
    return;
  }

  // SAFETY: lib.dom types `window.opener` as `any` because the
  // opener may be a Window from any origin. We post to our own
  // origin only, so narrowing to the postMessage surface is safe.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const opener = window.opener as Pick<Window, "postMessage"> | null;
  if (opener !== null) {
    opener.postMessage(message, window.location.origin);
  }
}

export function subscribeToMcpOAuthOutcome(
  handler: (outcome: McpOAuthOutcome) => void,
): () => void {
  const onMessage = (event: MessageEvent) => {
    const result = v.safeParse(mcpOAuthMessageSchema, event.data);
    if (!result.success) {
      return;
    }
    if (result.output.status === "connected") {
      handler({ status: "connected" });
      return;
    }
    handler({ status: "error", reason: result.output.reason });
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

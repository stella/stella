import { useRef } from "react";

import { Result } from "better-result";
import * as v from "valibot";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Temporal } from "@stll/time";

import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { requireBrowserStorage } from "@/lib/account/browser-storage";
import { MCP_OAUTH_REQUEST_STORAGE_KEY } from "@/lib/account/storage-keys";
import { createRandomValue } from "@/lib/uuid";

const CHANNEL_NAME = "mcp-oauth";
const MESSAGE_KIND = "stll.mcp-oauth";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const outcomeEvents = new EventTarget();
const OUTCOME_EVENT = "accepted-outcome";

type PostMessageOpener = {
  postMessage: (message: unknown, targetOrigin: string) => void;
};

// Wire schema carries a `kind` discriminator so the global
// `window.message` listener on the opener page can't pick up
// unrelated messages that happen to share `status`. Callers only
// see the public `McpOAuthOutcome` (without `kind`).
const mcpOAuthMessageSchema = v.variant("status", [
  v.strictObject({
    kind: v.literal(MESSAGE_KIND),
    nonce: v.string(),
    status: v.literal("connected"),
  }),
  v.strictObject({
    kind: v.literal(MESSAGE_KIND),
    nonce: v.string(),
    status: v.literal("error"),
    reason: v.string(),
  }),
]);

export type McpOAuthOutcome =
  { status: "connected" } | { status: "error"; reason: string };

class AcceptedMcpOAuthOutcomeEvent extends Event {
  readonly outcome: McpOAuthOutcome;

  constructor(outcome: McpOAuthOutcome) {
    super(OUTCOME_EVENT);
    this.outcome = outcome;
  }
}

export type McpOAuthReceipt =
  | { type: "accepted"; outcome: McpOAuthOutcome }
  | {
      type: "refused";
      reason: "invalid" | "foreign" | "expired" | "completed";
    };

export const createMcpOAuthRequest = (
  now = () => Temporal.Now.instant().epochMilliseconds,
) => {
  const nonce = createRandomValue();
  const expiresAt = now() + REQUEST_TTL_MS;
  let status: "pending" | "completed" = "pending";
  const receive = (message: unknown): McpOAuthReceipt => {
    const result = v.safeParse(mcpOAuthMessageSchema, message);
    if (!result.success) {
      return { type: "refused", reason: "invalid" };
    }
    if (result.output.nonce !== nonce) {
      return { type: "refused", reason: "foreign" };
    }
    if (status === "completed") {
      return { type: "refused", reason: "completed" };
    }
    if (now() >= expiresAt) {
      return { type: "refused", reason: "expired" };
    }
    status = "completed";
    const outcome: McpOAuthOutcome =
      result.output.status === "connected"
        ? { status: "connected" }
        : { status: "error", reason: result.output.reason };
    return { type: "accepted", outcome };
  };
  return { nonce, receive };
};

export type McpOAuthWindowStatus = "invalid" | "opened" | "redirected";

export const openMcpOAuthWindow = (
  authorizeUrl: string,
  onOutcome?: (outcome: McpOAuthOutcome) => void,
): McpOAuthWindowStatus => {
  const authorizeHref = sanitizeHref(authorizeUrl);
  if (authorizeHref === undefined || !URL.canParse(authorizeHref)) {
    return "invalid";
  }
  const parsedAuthorizeUrl = new URL(authorizeHref);
  if (
    parsedAuthorizeUrl.protocol !== "http:" &&
    parsedAuthorizeUrl.protocol !== "https:"
  ) {
    return "invalid";
  }

  const request = createMcpOAuthRequest();
  const unsubscribe = subscribeToRawMcpOAuthOutcome((message) => {
    const receipt = request.receive(message);
    if (receipt.type === "refused") {
      return;
    }
    unsubscribe();
    window.clearTimeout(expiry);
    onOutcome?.(receipt.outcome);
    outcomeEvents.dispatchEvent(
      new AcceptedMcpOAuthOutcomeEvent(receipt.outcome),
    );
  });
  const expiry = window.setTimeout(unsubscribe, REQUEST_TTL_MS);
  // A new _blank window starts as same-origin about:blank. Navigation to
  // authorizeHref begins after this script completes, so its origin-scoped
  // session storage can carry the nonce through the round trip. The provider
  // cannot read it, and it is never added to an authorization or redirect URL.
  const popup = window.open(authorizeHref, "_blank", "width=560,height=720");
  const stored = requireBrowserStorage("session", popup ?? window).andThen(
    (storage) =>
      Result.try(() =>
        storage.setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, request.nonce),
      ),
  );
  if (stored.isErr()) {
    unsubscribe();
    window.clearTimeout(expiry);
    popup?.close();
    return "invalid";
  }
  if (popup) {
    return "opened";
  }
  window.location.assign(authorizeHref);
  return "redirected";
};

// A component's callback expires on unmount or its next connect action. The
// request still consumes its outcome so mounted connection observers can refresh.
export const useMcpOAuthWindow = (
  onOutcome: (outcome: McpOAuthOutcome) => void,
) => {
  const disposeCallback = useRef<(() => void) | undefined>(undefined);
  const handleOutcome = useLatestCallback(onOutcome);
  useMountEffect(() => () => {
    disposeCallback.current?.();
  });
  return (authorizeUrl: string) => {
    disposeCallback.current?.();
    let status: "active" | "disposed" = "active";
    disposeCallback.current = () => {
      status = "disposed";
    };
    return openMcpOAuthWindow(authorizeUrl, (outcome) => {
      if (status === "active") {
        handleOutcome(outcome);
      }
    });
  };
};

const hasPostMessage = (value: object): value is PostMessageOpener => {
  if (!("postMessage" in value)) {
    return false;
  }

  const postMessage: unknown = value.postMessage;
  return typeof postMessage === "function";
};

export function broadcastMcpOAuthOutcome(outcome: McpOAuthOutcome): void {
  const stored = requireBrowserStorage("session").andThen((storage) =>
    Result.try(() => {
      const nonce = storage.getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
      storage.removeItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
      return nonce;
    }),
  );
  if (stored.isErr() || !stored.value) {
    return;
  }
  const message = { kind: MESSAGE_KIND, nonce: stored.value, ...outcome };

  // Prefer BroadcastChannel (covers same-origin tabs even when COOP
  // severs `window.opener`). Fall back to `opener.postMessage` only
  // when BroadcastChannel is unavailable, so the subscriber on the
  // opener page receives the outcome exactly once.
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    // BroadcastChannel.postMessage takes no targetOrigin; messages are
    // confined to the same origin by the browser's BroadcastChannel
    // contract.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no targetOrigin.
    channel.postMessage(message);
    channel.close();
    return;
  }

  const opener: unknown = window.opener;
  if (typeof opener !== "object" || opener === null) {
    return;
  }

  try {
    if (hasPostMessage(opener)) {
      opener.postMessage(message, window.location.origin);
    }
  } catch {
    // Cross-origin opener property access can throw SecurityError.
  }
}

function subscribeToRawMcpOAuthOutcome(
  handler: (message: unknown) => void,
): () => void {
  const onMessage = (event: MessageEvent) => {
    handler(event.data);
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

// Observers receive only outcomes already consumed by a live request. Per-window
// work belongs in the callback passed to openMcpOAuthWindow.
export function subscribeToMcpOAuthOutcome(
  handler: (outcome: McpOAuthOutcome) => void,
): () => void {
  const onOutcome = (event: Event) => {
    if (event instanceof AcceptedMcpOAuthOutcomeEvent) {
      handler(event.outcome);
    }
  };
  outcomeEvents.addEventListener(OUTCOME_EVENT, onOutcome);
  return () => {
    outcomeEvents.removeEventListener(OUTCOME_EVENT, onOutcome);
  };
}

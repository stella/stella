import * as v from "valibot";

import { visualRenderMessageSchema } from "@stll/api-contract/generated-visual";
import { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import {
  visualGuestMessageSchema,
  visualGuestPortMessageSchema,
} from "@stll/api-contract/visual-sandbox";
import {
  visualThemeMessageSchema,
  type VisualTheme,
} from "@stll/api-contract/visual-theme";

import { prepareGeneratedVisual } from "./prepare";
import type { SanitizedVisualHtml } from "./sanitize";

type SanitizedRenderMessage = Omit<
  v.InferOutput<typeof visualRenderMessageSchema>,
  "html"
> & {
  html: SanitizedVisualHtml;
};

/** The shell's end of the private channel a view's runtime opens. */
export type VisualGuestPort = {
  listen: (receive: (data: unknown) => void) => void;
  close: () => void;
};

export const visualGuestPortFrom = (port: MessagePort): VisualGuestPort => ({
  listen: (receive) => {
    port.addEventListener("message", (event) => receive(event.data));
    // A listener added this way leaves the port's queue paused until start.
    port.start();
  },
  close: () => port.close(),
});

type VisualGuestPortState =
  | { type: "awaiting" }
  | { type: "bound"; port: VisualGuestPort };

type VisualFrameEvent = {
  source: unknown;
  origin: string;
  data: unknown;
  ports?: readonly VisualGuestPort[];
};

type VisualMessageHandlerOptions = {
  parentWindow: unknown;
  innerWindow: unknown;
  outerOrigin: string;
  origins: readonly string[];
  onRender: (message: SanitizedRenderMessage) => void;
  onTheme: (theme: VisualTheme) => void;
  onGuestMessage: (
    message: v.InferOutput<typeof visualGuestMessageSchema>,
    hostOrigin: string,
  ) => void;
  /**
   * Whether this frame holds transient user activation. A gesture inside the
   * view activates its ancestor frames, this shell included; a gesture
   * elsewhere in the app does not.
   */
  hasUserActivation: () => boolean;
  now: () => number;
};

const GUEST_ACTION_INTERVAL_MS = 1000;

export const createVisualMessageHandler = ({
  parentWindow,
  innerWindow,
  outerOrigin,
  origins,
  onRender,
  onTheme,
  onGuestMessage,
  hasUserActivation,
  now,
}: VisualMessageHandlerOptions) => {
  let hostOrigin: string | undefined;
  const lastAction = new Map<string, number>();
  let actionGate: ReturnType<typeof createVisualActionGate> | undefined;
  // Each render loads a new view, whose runtime sends its port first, before
  // any page script runs. Only that first port is bound for the render.
  let guestPort: VisualGuestPortState = { type: "awaiting" };
  const receiveGuest = (data: unknown) => {
    if (!hostOrigin) {
      return;
    }
    const parsed = v.safeParse(visualGuestMessageSchema, data);
    if (!parsed.success) {
      return;
    }
    const sizing =
      parsed.output.kind === "resize" || parsed.output.kind === "ready";
    // The view is live from the start. Its runtime sends one action per
    // trusted gesture inside the view, through its private port, so page
    // script cannot act on the user's behalf. This frame checks again that
    // a gesture is recent and allows at most one of each kind per interval.
    if (!sizing) {
      const current = now();
      const previous =
        lastAction.get(parsed.output.kind) ?? Number.NEGATIVE_INFINITY;
      if (
        !hasUserActivation() ||
        current - previous < GUEST_ACTION_INTERVAL_MS
      ) {
        return;
      }
      if (!actionGate?.(parsed.output)) {
        return;
      }
      lastAction.set(parsed.output.kind, current);
    } else if (!actionGate?.(parsed.output)) {
      return;
    }
    onGuestMessage(parsed.output, hostOrigin);
  };
  const bindGuestPort = (event: VisualFrameEvent) => {
    const port = event.ports?.length === 1 ? event.ports[0] : undefined;
    if (
      guestPort.type !== "awaiting" ||
      port === undefined ||
      !v.safeParse(visualGuestPortMessageSchema, event.data).success
    ) {
      return;
    }
    const bound: VisualGuestPortState = { type: "bound", port };
    guestPort = bound;
    port.listen((data) => {
      if (guestPort === bound) {
        receiveGuest(data);
      }
    });
  };
  return (event: VisualFrameEvent) => {
    if (event.source === parentWindow) {
      if (event.origin === outerOrigin || !origins.includes(event.origin)) {
        return;
      }
      if (hostOrigin && hostOrigin !== event.origin) {
        return;
      }
      const theme = v.safeParse(visualThemeMessageSchema, event.data);
      if (theme.success) {
        if (hostOrigin) {
          onTheme(theme.output.theme);
        }
        return;
      }
      const parsed = v.safeParse(visualRenderMessageSchema, event.data);
      if (!parsed.success) {
        return;
      }
      const sanitized = prepareGeneratedVisual(parsed.output);
      if (sanitized.isErr()) {
        return;
      }
      hostOrigin = event.origin;
      actionGate = createVisualActionGate({
        data: sanitized.value.data,
        links: sanitized.value.links,
        literalLinks: sanitized.value.literalLinks,
        now,
      });
      if (guestPort.type === "bound") {
        guestPort.port.close();
      }
      guestPort = { type: "awaiting" };
      onRender({
        type: parsed.output.type,
        title: parsed.output.title,
        html: sanitized.value.html,
        data: sanitized.value.data,
        links: sanitized.value.links,
        ...(parsed.output.theme ? { theme: parsed.output.theme } : {}),
      });
      return;
    }
    // Messages from the view arrive only on its port; the window carries
    // just the one message that hands the port over.
    if (
      event.source !== innerWindow ||
      event.origin !== "null" ||
      !hostOrigin
    ) {
      return;
    }
    bindGuestPort(event);
  };
};

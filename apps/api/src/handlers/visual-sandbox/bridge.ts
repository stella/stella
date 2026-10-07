import * as v from "valibot";

import { visualRenderMessageSchema } from "@stll/api-contract/generated-visual";
import { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import { visualGuestMessageSchema } from "@stll/api-contract/visual-sandbox";

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
  return (event: { source: unknown; origin: string; data: unknown }) => {
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
    if (
      event.source !== innerWindow ||
      event.origin !== "null" ||
      !hostOrigin
    ) {
      return;
    }
    const parsed = v.safeParse(visualGuestMessageSchema, event.data);
    if (!parsed.success) {
      return;
    }
    const sizing =
      parsed.output.kind === "resize" || parsed.output.kind === "ready";
    // The view is live from the start, so an action reaches the app only
    // right after a gesture inside it, and at most one of each kind per
    // interval. Script that runs on load cannot act on the user's behalf.
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
};

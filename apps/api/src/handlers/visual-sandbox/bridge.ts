import * as v from "valibot";

import { visualRenderMessageSchema } from "@stll/api-contract/generated-visual";
import { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import { visualGuestMessageSchema } from "@stll/api-contract/visual-sandbox";

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
  onGuestMessage: (
    message: v.InferOutput<typeof visualGuestMessageSchema>,
    hostOrigin: string,
  ) => void;
};

export const createVisualMessageHandler = ({
  parentWindow,
  innerWindow,
  outerOrigin,
  origins,
  onRender,
  onGuestMessage,
}: VisualMessageHandlerOptions) => {
  let hostOrigin: string | undefined;
  let actionGate: ReturnType<typeof createVisualActionGate> | undefined;
  return (event: { source: unknown; origin: string; data: unknown }) => {
    if (event.source === parentWindow) {
      if (event.origin === outerOrigin || !origins.includes(event.origin)) {
        return;
      }
      if (hostOrigin && hostOrigin !== event.origin) {
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
        now: () => performance.now(),
      });
      onRender({
        type: parsed.output.type,
        title: parsed.output.title,
        html: sanitized.value.html,
        data: sanitized.value.data,
        links: sanitized.value.links,
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
    if (!parsed.success || !actionGate?.(parsed.output)) {
      return;
    }
    onGuestMessage(parsed.output, hostOrigin);
  };
};

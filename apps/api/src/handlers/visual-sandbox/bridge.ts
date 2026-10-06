import * as v from "valibot";

import {
  visualGuestMessageSchema,
  visualRenderMessageSchema,
} from "@stll/api-contract/visual-sandbox";

import { sanitizeVisualHtml, type SanitizedVisualHtml } from "./sanitize";

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
      const sanitized = sanitizeVisualHtml(parsed.output.html);
      if (sanitized.isErr()) {
        return;
      }
      hostOrigin = event.origin;
      onRender({
        type: parsed.output.type,
        title: parsed.output.title,
        html: sanitized.value,
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
    if (!parsed.success || parsed.output.type !== "resize") {
      return;
    }
    onGuestMessage(parsed.output, hostOrigin);
  };
};

import * as v from "valibot";

import {
  VISUAL_SANDBOX_LIMITS,
  visualGuestMessageSchema,
  visualRenderMessageSchema,
} from "@stll/api-contract/visual-sandbox";

type VisualMessageHandlerOptions = {
  parentWindow: unknown;
  innerWindow: unknown;
  outerOrigin: string;
  origins: readonly string[];
  onRender: (message: v.InferOutput<typeof visualRenderMessageSchema>) => void;
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
      if (
        !parsed.success ||
        new TextEncoder().encode(parsed.output.html).length >
          VISUAL_SANDBOX_LIMITS.htmlBytes
      ) {
        return;
      }
      hostOrigin = event.origin;
      onRender(parsed.output);
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
    onGuestMessage(parsed.output, hostOrigin);
  };
};

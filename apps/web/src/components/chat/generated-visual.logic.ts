import * as v from "valibot";

import type { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import { visualGuestMessageSchema } from "@stll/api-contract/visual-sandbox";

type ParseVisualHostMessageOptions = {
  event: { source: unknown; origin: string; data: unknown };
  frameWindow: unknown;
  outerOrigin: string;
  actionGate: ReturnType<typeof createVisualActionGate> | null;
};

export const parseVisualHostMessage = ({
  event,
  frameWindow,
  outerOrigin,
  actionGate,
}: ParseVisualHostMessageOptions) => {
  if (
    frameWindow === null ||
    frameWindow === undefined ||
    event.source !== frameWindow ||
    event.origin !== outerOrigin ||
    actionGate === null
  ) {
    return null;
  }
  const parsed = v.safeParse(visualGuestMessageSchema, event.data);
  if (!parsed.success || !actionGate(parsed.output)) {
    return null;
  }
  return parsed.output;
};

import * as v from "valibot";

import type { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import { visualGuestMessageSchema } from "@stll/api-contract/visual-sandbox";

type ParseVisualHostMessageOptions = {
  event: { source: unknown; origin: string; data: unknown };
  frameWindow: unknown;
  outerOrigin: string;
  actionGate: ReturnType<typeof createVisualActionGate> | null;
  /**
   * Whether the app holds transient user activation. The frame shell already
   * forwards an action only right after a gesture inside the view (which
   * activates the app as well); this is the app's own check of the same rule.
   */
  userActivated: boolean;
};

export const parseVisualHostMessage = ({
  event,
  frameWindow,
  outerOrigin,
  actionGate,
  userActivated,
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
  if (!parsed.success) {
    return null;
  }
  if (
    parsed.output.kind !== "resize" &&
    parsed.output.kind !== "ready" &&
    !userActivated
  ) {
    return null;
  }
  return actionGate(parsed.output) ? parsed.output : null;
};

import * as v from "valibot";

import type { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import { visualGuestMessageSchema } from "@stll/api-contract/visual-sandbox";

// "loading" lasts until the frame's document finishes loading. Each load
// returns the view to "preview", so activation waits for it: an activation
// before the first load would be reset by that load.
export type VisualInteraction =
  | { status: "loading" }
  | { status: "preview" }
  | { status: "interactive"; activatedFrame: unknown };

export const activateVisual = (
  interaction: VisualInteraction,
  activatedFrame: unknown,
): VisualInteraction =>
  interaction.status === "preview" &&
  activatedFrame !== null &&
  activatedFrame !== undefined
    ? { status: "interactive", activatedFrame }
    : interaction;

type ParseVisualHostMessageOptions = {
  interaction: VisualInteraction;
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
  interaction,
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
    (interaction.status !== "interactive" ||
      interaction.activatedFrame !== frameWindow)
  ) {
    return null;
  }
  return actionGate(parsed.output) ? parsed.output : null;
};

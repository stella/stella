import * as v from "valibot";

import {
  VISUAL_SHELL_NONCE_PARAMETER,
  visualShellReadySchema,
} from "@stll/api-contract/visual-sandbox";

type VisualShellSessionOptions = { url: string; newNonce: () => string };
type VisualShellSessionState =
  | { type: "uninitialized" }
  | { type: "awaiting-ready"; nonce: string }
  | { type: "ready" };

export const createVisualShellSession = ({
  url,
  newNonce,
}: VisualShellSessionOptions) => {
  let state: VisualShellSessionState = { type: "uninitialized" };
  return {
    // A completed document load replaces the previous document's handshake.
    beginLoad: () => {
      const nonce = newNonce();
      const target = new URL(url);
      target.hash = new URLSearchParams({
        [VISUAL_SHELL_NONCE_PARAMETER]: nonce,
      }).toString();
      state = { type: "awaiting-ready", nonce };
      return target.href;
    },
    acceptReady: ({
      event,
      frameWindow,
    }: {
      event: { source: unknown; origin: string; data: unknown };
      frameWindow: unknown;
    }) => {
      if (
        state.type !== "awaiting-ready" ||
        frameWindow === null ||
        frameWindow === undefined ||
        event.source !== frameWindow ||
        event.origin !== "null"
      ) {
        return false;
      }
      const parsed = v.safeParse(visualShellReadySchema, event.data);
      if (!parsed.success || parsed.output.nonce !== state.nonce) {
        return false;
      }
      state = { type: "ready" };
      return true;
    },
    isReady: () => state.type === "ready",
  };
};

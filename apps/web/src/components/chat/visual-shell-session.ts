import * as v from "valibot";

import type { visualRenderMessageSchema } from "@stll/api-contract/generated-visual";
import {
  VISUAL_SHELL_NONCE_PARAMETER,
  visualShellReadySchema,
} from "@stll/api-contract/visual-sandbox";

type VisualShellSessionOptions = { url: string; newNonce: () => string };
type VisualShellSessionState =
  | { type: "uninitialized" }
  | { type: "awaiting-ready"; nonce: string }
  | { type: "ready"; nonce: string };

type ShellFrameWindow =
  | { postMessage: (message: unknown, targetOrigin: string) => void }
  | null
  | undefined;

type ShellEvent = { source: unknown; origin: string; data: unknown };

const shellReadyNonce = (event: ShellEvent, frameWindow: ShellFrameWindow) => {
  if (
    frameWindow === null ||
    frameWindow === undefined ||
    event.source !== frameWindow ||
    event.origin !== "null"
  ) {
    return null;
  }
  const parsed = v.safeParse(visualShellReadySchema, event.data);
  return parsed.success ? parsed.output.nonce : null;
};

// Each nonce releases the payload once. A shell document announces itself
// with the nonce in its URL, so a reloaded shell repeats the spent nonce:
// that, not the frame's load event, starts the next handshake. Changing the
// frame's URL fires a load event for a cross-origin frame even when only the
// fragment changes, so a handshake started on load would never settle.
export const createVisualShellSession = ({
  url,
  newNonce,
}: VisualShellSessionOptions) => {
  let state: VisualShellSessionState = { type: "uninitialized" };
  return {
    beginLoad: () => {
      const nonce = newNonce();
      const target = new URL(url);
      target.hash = new URLSearchParams({
        [VISUAL_SHELL_NONCE_PARAMETER]: nonce,
      }).toString();
      state = { type: "awaiting-ready", nonce };
      return target.href;
    },
    deliverRender: ({
      event,
      frameWindow,
      message,
    }: {
      event: ShellEvent;
      frameWindow: ShellFrameWindow;
      message: v.InferOutput<typeof visualRenderMessageSchema>;
    }) => {
      if (state.type !== "awaiting-ready" || !frameWindow) {
        return false;
      }
      if (shellReadyNonce(event, frameWindow) !== state.nonce) {
        return false;
      }
      state = { type: "ready", nonce: state.nonce };
      frameWindow.postMessage(message, "*");
      return true;
    },
    /** A shell document that loaded after the payload was released. */
    isReloadedShell: ({
      event,
      frameWindow,
    }: {
      event: ShellEvent;
      frameWindow: ShellFrameWindow;
    }) =>
      state.type === "ready" &&
      shellReadyNonce(event, frameWindow) === state.nonce,
    isReady: () => state.type === "ready",
  };
};

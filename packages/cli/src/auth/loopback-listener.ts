// Ephemeral 127.0.0.1 listener for the loopback redirect (RFC 8252).
//
// Binds port 0 (OS-assigned) so concurrent logins and busy dev machines never
// collide. The registered client's redirect_uri has no port (see
// `constants.ts#LOOPBACK_REDIRECT_URI`); better-auth's loopback exemption
// matches on hostname/pathname/protocol/search only, so any ephemeral port
// still satisfies the registered redirect_uri.

import { LOOPBACK_REDIRECT_PATH } from "./constants.js";
import { LoopbackCallbackError, LoopbackTimeoutError } from "./errors.js";

export type LoopbackCallback =
  | { readonly kind: "success"; readonly code: string; readonly state: string }
  | {
      readonly kind: "error";
      readonly error: string;
      readonly errorDescription?: string;
      readonly state?: string;
    };

export type LoopbackListener = {
  readonly port: number;
  readonly redirectUri: string;
  readonly waitForCallback: (
    timeoutMs: number,
  ) => Promise<LoopbackCallback | LoopbackTimeoutError>;
  readonly close: () => void;
};

const renderCallbackPage = (ok: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>stella CLI</title></head>` +
  `<body><p>${ok ? "Signed in. You can close this tab and return to the terminal." : "Sign-in failed. Return to the terminal for details."}</p></body></html>`;

const raceWithTimeout = async (
  received: Promise<LoopbackCallback>,
  timeoutMs: number,
): Promise<LoopbackCallback | LoopbackTimeoutError> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LoopbackTimeoutError>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        new LoopbackTimeoutError({
          message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser sign-in to complete.`,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([received, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/**
 * Starts the loopback HTTP listener. Returns `undefined` if binding fails
 * (sandboxed/offline environments) so callers can fall back to the manual
 * paste flow instead of crashing.
 */
export const startLoopbackListener = (): LoopbackListener | undefined => {
  let deliver: ((callback: LoopbackCallback) => void) | undefined;
  const received = new Promise<LoopbackCallback>((resolve) => {
    deliver = resolve;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== LOOPBACK_REDIRECT_PATH) {
          return new Response("Not found", { status: 404 });
        }

        const error = url.searchParams.get("error");
        if (error) {
          const errorDescription = url.searchParams.get("error_description");
          const state = url.searchParams.get("state");
          deliver?.({
            error,
            kind: "error",
            ...(errorDescription ? { errorDescription } : {}),
            ...(state ? { state } : {}),
          });
          return new Response(renderCallbackPage(false), {
            headers: { "Content-Type": "text/html" },
          });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          return new Response("Missing code or state", { status: 400 });
        }

        deliver?.({ code, kind: "success", state });
        return new Response(renderCallbackPage(true), {
          headers: { "Content-Type": "text/html" },
        });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
  } catch {
    return undefined;
  }

  // `Server.port` is typed optional to cover unix-socket servers; a
  // `hostname`+`port: 0` TCP server (as configured above) always reports a
  // real port, so this fallback is unreachable in practice.
  const listenerPort = server.port ?? 0;

  return {
    // `Server.stop()` returns a `Promise<void>` that resolves once in-flight
    // connections drain; the CLI doesn't need to wait for that; it just
    // needs the port freed and no more callbacks delivered.
    close: () => {
      void server.stop(true);
    },
    port: listenerPort,
    redirectUri: `http://127.0.0.1:${listenerPort}${LOOPBACK_REDIRECT_PATH}`,
    waitForCallback: async (timeoutMs) =>
      await raceWithTimeout(received, timeoutMs),
  };
};

/** Converts a listener callback into the `TaggedError` shape the login flow expects. */
export const toLoopbackCallbackError = (
  callback: Extract<LoopbackCallback, { kind: "error" }>,
): LoopbackCallbackError =>
  new LoopbackCallbackError({
    message:
      callback.error === "set_organization"
        ? "Your account needs an active organization before granting stella CLI access. Complete organization setup in the browser (create or select one), then re-run `stella auth login`."
        : (callback.errorDescription ?? callback.error),
    oauthError: callback.error,
    oauthErrorDescription: callback.errorDescription,
  });

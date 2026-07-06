// Ephemeral 127.0.0.1 listener for the loopback redirect (RFC 8252).
//
// Binds port 0 (OS-assigned) so concurrent logins and busy dev machines never
// collide. The registered client's redirect_uri has no port (see
// `constants.ts#LOOPBACK_REDIRECT_URI`); better-auth's loopback exemption
// matches on hostname/pathname/protocol/search only, so any ephemeral port
// still satisfies the registered redirect_uri.

import { createServer } from "node:http";

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
 * Starts the loopback HTTP listener. Resolves to `undefined` if binding fails
 * (sandboxed/offline environments) so callers can fall back to the manual
 * paste flow instead of crashing. Async because `node:http`'s `listen` reports
 * its OS-assigned port on the `listening` event, not synchronously.
 */
export const startLoopbackListener = async (): Promise<
  LoopbackListener | undefined
> => {
  let deliver: ((callback: LoopbackCallback) => void) | undefined;
  const received = new Promise<LoopbackCallback>((resolve) => {
    deliver = resolve;
  });

  const server = createServer((request, response) => {
    // `request.url` is the path+query only; rebuild a full URL against the
    // fixed loopback host to parse the query string.
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== LOOPBACK_REDIRECT_PATH) {
      response.writeHead(404);
      response.end("Not found");
      return;
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
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(renderCallbackPage(false));
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      response.writeHead(400);
      response.end("Missing code or state");
      return;
    }

    deliver?.({ code, kind: "success", state });
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(renderCallbackPage(true));
  });

  const listenerPort = await new Promise<number | undefined>((resolve) => {
    // A pre-`listening` bind error (EADDRINUSE, EACCES, sandbox) resolves to
    // `undefined`; the same handler stays attached afterward so a later socket
    // error is absorbed rather than thrown as an uncaught `error` event.
    server.on("error", () => resolve(undefined));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        address !== null && typeof address === "object"
          ? address.port
          : undefined,
      );
    });
  });

  if (listenerPort === undefined) {
    server.close();
    return undefined;
  }

  return {
    // The CLI just needs the port freed and no more callbacks delivered;
    // `closeAllConnections` drops any lingering keep-alive socket so the
    // event loop can exit, then `close` stops accepting new connections.
    close: () => {
      server.closeAllConnections();
      server.close();
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

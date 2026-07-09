// Ephemeral 127.0.0.1 listener for the loopback redirect (RFC 8252).
//
// Binds port 0 (OS-assigned) so concurrent logins and busy dev machines never
// collide. The registered client's redirect_uri has no port (see
// `constants.ts#LOOPBACK_REDIRECT_URI`); better-auth's loopback exemption
// matches on hostname/pathname/protocol/search only, so any ephemeral port
// still satisfies the registered redirect_uri.

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

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

const renderCallbackPage = (ok: boolean): string => {
  const title = ok ? "Signed in" : "Sign-in failed";
  const message = ok
    ? "Return to your terminal to continue."
    : "Return to the terminal for details.";
  const statusColor = ok ? "#18181b" : "#b91c1c";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      body {
        align-items: center;
        background: #fafafa;
        color: #18181b;
        display: flex;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
        -webkit-font-smoothing: antialiased;
      }
      main {
        background: #ffffff;
        border: 1px solid rgb(24 24 27 / 8%);
        border-radius: 8px;
        box-shadow:
          0 1px 2px rgb(24 24 27 / 4%),
          0 24px 80px rgb(24 24 27 / 8%);
        display: grid;
        gap: 28px;
        max-width: 480px;
        padding: 32px;
        width: min(100%, 480px);
      }
      .brand {
        align-items: center;
        color: #18181b;
        display: flex;
        gap: 12px;
        min-width: 0;
      }
      .mark {
        color: #18181b;
        height: 28px;
        width: 28px;
      }
      .label {
        color: #71717a;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        line-height: 1;
      }
      h1 {
        color: ${statusColor};
        font-size: 24px;
        font-weight: 600;
        letter-spacing: 0;
        line-height: 1.15;
        margin: 0;
        text-wrap: balance;
      }
      p {
        color: #52525b;
        font-size: 15px;
        line-height: 1.6;
        margin: 10px 0 0;
        text-wrap: pretty;
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #09090b;
          color: #fafafa;
        }
        main {
          background: #18181b;
          border-color: rgb(250 250 250 / 8%);
          box-shadow: 0 24px 80px rgb(0 0 0 / 24%);
        }
        .brand,
        .mark {
          color: #fafafa;
        }
        h1 {
          color: ${ok ? "#fafafa" : "#fca5a5"};
        }
        .label,
        p {
          color: #a1a1aa;
        }
        path {
          fill: currentColor;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <svg aria-hidden="true" class="mark" fill="currentColor" viewBox="0 0 40 41" xmlns="http://www.w3.org/2000/svg">
          <path d="M6.58 11.3 16.69 5.05a5.9 5.9 0 0 1 6.62.01l14.68 9.07V9.26L25.52 1.55A11.8 11.8 0 0 0 20 0c-1.97 0-3.88.54-5.53 1.56L4.37 7.81A9.3 9.3 0 0 0 0 15.61a9.3 9.3 0 0 0 4.37 7.8l3.26 2.02-.01.01 11.15 6.9c.14.09.27.16.39.2.68.26 1.42.19 2.03-.19l9.59-5.93.1-.07 2.07-1.28-2.82-1.72-1.1-.69-9.02 5.56-.41-.24-13.01-8.05a5.57 5.57 0 0 1-2.41-4.31c0-1.79.88-3.36 2.41-4.3Z" />
          <path d="M33.34 29.25 23.24 35.5a5.9 5.9 0 0 1-6.63-.01L1.94 26.43v4.86l12.47 7.71a11.8 11.8 0 0 0 5.52 1.55c1.97 0 3.88-.54 5.53-1.56l10.1-6.25a9.3 9.3 0 0 0 4.37-7.8 9.3 9.3 0 0 0-4.37-7.8l-3.26-2.02.01-.01-11.15-6.9a1.6 1.6 0 0 0-.39-.2 1.64 1.64 0 0 0-2.03.19l-9.59 5.93-.1.07-2.07 1.28 2.82 1.72 1.1.69 9.02-5.56.41.24 13.01 8.05a5.57 5.57 0 0 1 2.41 4.31c0 1.79-.88 3.36-2.41 4.3Z" />
        </svg>
        <span class="label">stella cli</span>
      </div>
      <section>
        <h1>${title}</h1>
        <p>${message}</p>
      </section>
    </main>
  </body>
</html>`;
};

const sendCallbackPage = (
  response: ServerResponse,
  ok: boolean,
  onSent: () => void,
) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(renderCallbackPage(ok), onSent);
};

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
      sendCallbackPage(response, false, () => {
        deliver?.({
          error,
          kind: "error",
          ...(errorDescription ? { errorDescription } : {}),
          ...(state ? { state } : {}),
        });
      });
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      response.writeHead(400);
      response.end("Missing code or state");
      return;
    }

    sendCallbackPage(response, true, () => {
      deliver?.({ code, kind: "success", state });
    });
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

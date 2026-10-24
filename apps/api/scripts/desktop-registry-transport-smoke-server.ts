import { panic } from "better-result";
import * as v from "valibot";

import { createHttpApp } from "../src/http/app";
import { requestHeaders } from "../src/http/context";
import type { Middleware, RouteDefinition } from "../src/http/route";
import { routes } from "../src/http/route";
import { status } from "../src/http/status";
import {
  DESKTOP_REGISTRY_REQUEST_PATH,
  DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE,
  desktopRegistryNativeRequestHeaders,
  desktopRegistryRequestBody,
} from "../src/lib/business-registries/desktop/request-contract";

const outputPath = process.argv.at(2);
if (!outputPath) {
  panic("Pass the file where the smoke server should write its URL");
}

let exitCode = 1;
const { promise: completed, resolve: finish } =
  Promise.withResolvers<undefined>();

/**
 * The desktop registry request, read the way the API's route table serves it:
 * a request whose headers and body match the shared contract gets the answer
 * the API gives an unknown token.
 */
const desktopRegistryRequest: RouteDefinition = {
  config: {
    headers: desktopRegistryNativeRequestHeaders,
    body: desktopRegistryRequestBody,
  },
  access: "public",
  run: async ({ ctx, readBody }) => {
    const body = await readBody().catch(() => undefined);
    const matches =
      v.is(desktopRegistryNativeRequestHeaders, requestHeaders(ctx.request)) &&
      v.is(desktopRegistryRequestBody, body);
    exitCode = matches ? 0 : 1;
    return matches
      ? status(
          DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.status,
          DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.body,
        )
      : status(500, { message: "Desktop request contract mismatch" });
  },
};

/** One request decides the smoke: stop once it is answered, whatever it was. */
const stopAfterFirstRequest: Middleware = async (_ctx, inner) => {
  try {
    return await inner();
  } finally {
    setTimeout(() => {
      void server.stop();
      finish(undefined);
    }, 0);
  }
};

const app = createHttpApp({
  routes: routes({
    [DESKTOP_REGISTRY_REQUEST_PATH]: { POST: desktopRegistryRequest },
  }),
  middleware: [stopAfterFirstRequest],
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  ...app.serveOptions,
});

await Bun.write(outputPath, `${server.url.origin}\n`);
await completed;
process.exit(exitCode);

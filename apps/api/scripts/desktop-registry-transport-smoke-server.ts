import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";

import {
  DESKTOP_REGISTRY_REQUEST_PATH,
  DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE,
  desktopRegistryRequestBody,
  desktopRegistryRequestHeaders,
} from "../src/lib/business-registries/desktop/request-contract";

const outputPath = process.argv.at(2);
if (!outputPath) {
  panic("Pass the file where the smoke server should write its URL");
}

let exitCode = 1;
const { promise: completed, resolve: finish } =
  Promise.withResolvers<undefined>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => undefined);
    const headers = Object.fromEntries(request.headers);
    const matches =
      request.method === "POST" &&
      url.pathname === DESKTOP_REGISTRY_REQUEST_PATH &&
      Value.Check(desktopRegistryRequestHeaders, headers) &&
      Value.Check(desktopRegistryRequestBody, body);

    exitCode = matches ? 0 : 1;
    setTimeout(() => {
      void server.stop();
      finish(undefined);
    }, 0);
    if (!matches) {
      return Response.json(
        { message: "Desktop request contract mismatch" },
        { status: 500 },
      );
    }
    return Response.json(DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.body, {
      status: DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.status,
    });
  },
});

await Bun.write(outputPath, `${server.url.origin}\n`);
await completed;
process.exit(exitCode);

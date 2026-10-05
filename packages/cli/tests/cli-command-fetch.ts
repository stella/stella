// Subprocess boundary for command tests: keep the real MCP transport while
// preventing advisory npm lookups from reaching the network or changing stderr.
import { panic } from "better-result";

import { CLI_VERSION } from "../src/generated/cli-version.js";

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (
      url.origin === "https://registry.npmjs.org" &&
      url.pathname === "/@stll%2Fcli/latest"
    ) {
      return Response.json({ version: CLI_VERSION });
    }
    if (
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]"
    ) {
      return panic(`Unexpected external command-test request: ${url.origin}`);
    }
    return originalFetch(input, init);
  },
  { preconnect: originalFetch.preconnect },
);

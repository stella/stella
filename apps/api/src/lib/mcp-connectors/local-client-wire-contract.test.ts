import { describe, expect, test } from "bun:test";

import { localCliClientHeaders } from "@stll/cli/local-client-identity";
import { localMcpClientHeaders } from "@stll/mcp-kit";

import {
  CLIENT_TOO_OLD_CODE,
  clientTooOldError,
  LOCAL_CLIENT_SUPPORT,
} from "./local-client-support";

const publishedClientHeaders = [
  {
    kind: "cli",
    version: "0.0.0",
    headers: localCliClientHeaders("0.0.0"),
  },
  {
    kind: "mcp-kit",
    version: "0.0.0",
    headers: localMcpClientHeaders("0.0.0"),
  },
] as const;

describe("published local-client wire contract", () => {
  for (const client of publishedClientHeaders) {
    test(`recognises ${client.kind} identity headers and takes the unsupported-client path`, () => {
      const error = clientTooOldError(
        new Request("https://api.example.test/mcp", {
          headers: client.headers,
        }),
      );

      expect(error).toMatchObject({
        code: CLIENT_TOO_OLD_CODE,
        client_kind: client.kind,
        current_version: client.version,
        minimum_version: LOCAL_CLIENT_SUPPORT[client.kind].minimum,
      });
    });
  }
});

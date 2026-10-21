import { describe, expect, test } from "bun:test";

import {
  CLIENT_TOO_OLD_CODE,
  clientTooOldError,
  LOCAL_CLIENT_IDENTITY_HEADER,
  LOCAL_CLIENT_KINDS,
  LOCAL_CLIENT_SUPPORT,
} from "./local-client-support";

const localClientIdentity = (kind: string, version: string): string =>
  `${kind}/${version}`;

const REPOSITORY_ROOT = new URL("../../../../../", import.meta.url);
const CLIENT_IDENTITY_OWNERS = {
  cli: "packages/cli/src/api-fetch.ts",
  "mcp-kit": "packages/mcp-kit/src/local-client-identity.ts",
  desktop: "apps/desktop/src-tauri/src/http_client.rs",
} as const satisfies Record<(typeof LOCAL_CLIENT_KINDS)[number], string>;

const request = (identity?: string) =>
  new Request("https://api.example.test/mcp", {
    headers: identity ? { [LOCAL_CLIENT_IDENTITY_HEADER]: identity } : {},
  });

describe("local client support", () => {
  test("every client kind has a complete support and update policy", () => {
    expect(Object.keys(LOCAL_CLIENT_SUPPORT).toSorted()).toEqual(
      [...LOCAL_CLIENT_KINDS].toSorted(),
    );
    for (const kind of LOCAL_CLIENT_KINDS) {
      expect(LOCAL_CLIENT_SUPPORT[kind].minimum).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(LOCAL_CLIENT_SUPPORT[kind].latest).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(LOCAL_CLIENT_SUPPORT[kind].update).toBeDefined();
    }
  });

  test("every shipped local client sends its identity", async () => {
    for (const kind of LOCAL_CLIENT_KINDS) {
      const path = CLIENT_IDENTITY_OWNERS[kind];
      const source = await Bun.file(new URL(path, REPOSITORY_ROOT)).text();
      const marker =
        kind === "desktop"
          ? "LOCAL_CLIENT_IDENTITY_HEADER"
          : ["`", kind, "/${"].join("");
      expect(
        source,
        `${path}:1 must send the ${kind} local client identity`,
      ).toContain(marker);
    }
  });

  for (const kind of LOCAL_CLIENT_KINDS) {
    test(`${kind}: below minimum is typed and supported passes`, () => {
      const rejected = clientTooOldError(
        request(localClientIdentity(kind, "0.0.0")),
      );
      expect(rejected?.code).toBe(CLIENT_TOO_OLD_CODE);
      expect(rejected?.update).toEqual(LOCAL_CLIENT_SUPPORT[kind].update);
      expect(
        clientTooOldError(
          request(
            localClientIdentity(kind, LOCAL_CLIENT_SUPPORT[kind].minimum),
          ),
        ),
      ).toBeUndefined();
    });
  }

  test("remote MCP without local identity is unaffected", () => {
    expect(clientTooOldError(request())).toBeUndefined();
  });
});

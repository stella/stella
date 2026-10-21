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

// The CLI and MCP kit identities run through their own builders in
// local-client-wire-contract.test.ts; the Rust desktop client cannot be
// imported, so its source must reference the header.
const DESKTOP_IDENTITY_OWNER = new URL(
  "../../../../../apps/desktop/src-tauri/src/http_client.rs",
  import.meta.url,
);

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

  test("the desktop client sends its identity", async () => {
    const source = await Bun.file(DESKTOP_IDENTITY_OWNER).text();
    expect(
      source,
      "apps/desktop/src-tauri/src/http_client.rs:1 must send the desktop local client identity",
    ).toContain("LOCAL_CLIENT_IDENTITY_HEADER");
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

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import cliPackage from "@stll/cli/package.json" with { type: "json" };
import mcpKitPackage from "@stll/mcp-kit/package.json" with { type: "json" };

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

const DESKTOP_MANIFEST = new URL(
  "../../../../../apps/desktop/src-tauri/Cargo.toml",
  import.meta.url,
);

// The desktop binary reports CARGO_PKG_VERSION, the `[package]` version.
const CARGO_PACKAGE_VERSION_PATTERN = /^version = "([^"]+)"$/mu;

const desktopWorkspaceVersion = async (): Promise<string> =>
  CARGO_PACKAGE_VERSION_PATTERN.exec(
    await Bun.file(DESKTOP_MANIFEST).text(),
  )?.at(1) ??
  panic("apps/desktop/src-tauri/Cargo.toml declares no package version");

// The version each client built from this tree reports on the wire.
const WORKSPACE_CLIENT_VERSIONS = {
  cli: async () => cliPackage.version,
  "mcp-kit": async () => mcpKitPackage.version,
  desktop: desktopWorkspaceVersion,
} as const satisfies Record<
  (typeof LOCAL_CLIENT_KINDS)[number],
  () => Promise<string>
>;

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
    test(`${kind}: the client built from this tree is supported and latest`, async () => {
      const version = await WORKSPACE_CLIENT_VERSIONS[kind]();
      expect(
        version,
        `${kind}: the workspace manifest must declare a version`,
      ).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(
        clientTooOldError(request(localClientIdentity(kind, version))),
        `${kind}: LOCAL_CLIENT_SUPPORT.${kind}.minimum (${LOCAL_CLIENT_SUPPORT[kind].minimum}) must not exceed the workspace version ${version}`,
      ).toBeUndefined();
      expect(LOCAL_CLIENT_SUPPORT[kind].latest).toBe(version);
    });

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

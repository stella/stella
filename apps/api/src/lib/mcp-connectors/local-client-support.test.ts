import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
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

// The table of desktop-facing edit routes: opening a session (the handoff
// redeem) and continuing one.
const DESKTOP_EDIT_ROUTES = new URL(
  "../../handlers/entities/desktop-edit-sessions-route.ts",
  import.meta.url,
);
const DESKTOP_EDIT_ROUTE_PATTERN = /^\s+"(\/desktop-edit-[^"]+)": \{/gmu;
const OPEN_SESSION_ROUTE_PREFIX = "/desktop-edit-sessions/";

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

const request = (identity?: string, path = "/mcp") =>
  new Request(`https://api.example.test${path}`, {
    headers: identity ? { [LOCAL_CLIENT_IDENTITY_HEADER]: identity } : {},
  });

// Below every minimum, and no client's workspace version.
const UNSUPPORTED_VERSION = "0.0.0";

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
        `${kind}: the API must accept the client built from this checkout (${version}); its minimum is ${LOCAL_CLIENT_SUPPORT[kind].minimum}`,
      ).toBeUndefined();
      expect(LOCAL_CLIENT_SUPPORT[kind].latest).toBe(version);
    });

    test(`${kind}: below minimum is typed and supported passes`, () => {
      const rejected = clientTooOldError(
        request(localClientIdentity(kind, UNSUPPORTED_VERSION)),
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

  test("the desktop workspace version passes the floor as a desktop only", async () => {
    const version = await desktopWorkspaceVersion();
    for (const kind of LOCAL_CLIENT_KINDS) {
      expect(
        clientTooOldError(request(localClientIdentity(kind, version)))?.code,
        kind,
      ).toBe(kind === "desktop" ? undefined : CLIENT_TOO_OLD_CODE);
    }
  });

  test("a desktop below the floor continues open edit sessions and opens none", async () => {
    const source = await Bun.file(DESKTOP_EDIT_ROUTES).text();
    const routes = [...source.matchAll(DESKTOP_EDIT_ROUTE_PATTERN)].flatMap(
      (match) => match.at(1) ?? [],
    );
    const continued = routes.filter((route) =>
      route.startsWith(OPEN_SESSION_ROUTE_PREFIX),
    );
    expect(continued.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(continued.length);
    for (const route of routes) {
      const path = `${STELLA_API_VERSION_PREFIX}${route.replaceAll(/:[A-Za-z]+/gu, "id")}`;
      expect(
        clientTooOldError(
          request(localClientIdentity("desktop", UNSUPPORTED_VERSION), path),
        )?.code,
        route,
      ).toBe(continued.includes(route) ? undefined : CLIENT_TOO_OLD_CODE);
      // Only a desktop holds edit sessions.
      expect(
        clientTooOldError(
          request(localClientIdentity("cli", UNSUPPORTED_VERSION), path),
        )?.code,
        route,
      ).toBe(CLIENT_TOO_OLD_CODE);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_SCOPES,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
} from "@/api/mcp/constants";
import { MCP_ERROR_CODES } from "@/api/mcp/error-codes";

// The companion `@stll/cli` hand-mirrors several values owned by `apps/api`
// because `packages/cli` cannot import `apps/api` at runtime (apps depend on
// packages, never the reverse) and these are not yet exposed as fetchable data.
// This guard pins the mirror so a change on the server side fails here until the
// CLI is updated in lockstep.
//
// The CLI sources are read as TEXT (not imported) on purpose: this test file
// lives under `apps/api/src`, which is type-checked, so a static cross-package
// import would pull `packages/cli` into the api type graph and could trip a
// project/rootDir or cross-package ratchet boundary. Text extraction keeps the
// guard's coupling one-directional and boundary-free while still reading the
// real, current CLI file contents at test time. The extracted blocks are flat
// literal arrays/objects with no nesting or inline comments (asserted below).

const cliFile = (relativePath: string): string => {
  const url = new URL(
    `../../../../packages/cli/${relativePath}`,
    import.meta.url,
  );
  return readFileSync(url, "utf8");
};

/** Extract the `"..."` string literals inside the first `marker` array block. */
const extractStringArray = (text: string, marker: string): string[] => {
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`marker not found: ${marker}`);
  }
  const open = text.indexOf("[", start);
  const close = text.indexOf("]", open);
  const block = text.slice(open + 1, close);
  return [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
};

/** Extract the object keys inside the first `marker` object block. */
const extractObjectKeys = (text: string, marker: string): string[] => {
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`marker not found: ${marker}`);
  }
  const open = text.indexOf("{", start);
  const close = text.indexOf("}", open);
  const block = text.slice(open + 1, close);
  return [...block.matchAll(/^\s*(\w+):/gmu)].map((match) => match[1] ?? "");
};

const parseSemver = (version: string): [number, number, number] => {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`unparseable semver: ${version}`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};

/** -1 / 0 / 1 for a < b / a == b / a > b. */
const compareSemver = (a: string, b: string): number => {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }
  return 0;
};

describe("CLI mirrors of apps/api MCP constants", () => {
  test("every server error code maps to a CLI exit class (and no stale mappings)", () => {
    // A new code in MCP_ERROR_CODES would arrive at the CLI as an unmapped
    // `error.code` and silently fall through to the generic server-error exit;
    // a removed code would leave a dead mapping. Both are drift, so pin equality.
    const mappedCodes = extractObjectKeys(
      cliFile("src/mcp-constants.ts"),
      "MCP_ERROR_CODE_EXIT_MAP",
    );

    expect(new Set(mappedCodes)).toEqual(new Set(MCP_ERROR_CODES));
  });

  test("CLI known scopes equal the default resource scopes plus the OIDC protocol scopes", () => {
    // The CLI's login `--scopes` allow-list must mirror exactly the server's
    // default resource scopes (never the anonymized ones) plus the OIDC
    // protocol scopes carried in MCP_OAUTH_SCOPES (openid/profile/email and
    // offline_access, which earns the stored refresh token).
    const cliKnownScopes = extractStringArray(
      cliFile("src/auth/constants.ts"),
      "CLI_KNOWN_SCOPES",
    );
    const protocolScopes = MCP_OAUTH_SCOPES.filter(
      (scope) => !scope.startsWith("stella:"),
    );

    expect(new Set(cliKnownScopes)).toEqual(
      new Set([...protocolScopes, ...MCP_DEFAULT_RESOURCE_SCOPES]),
    );
  });

  test("the packed CLI version sits within the API's advertised support band", () => {
    // The production canary checks the exact packed CLI version against the
    // inclusive [MINIMUM, MAXIMUM] band the API advertises. Bumping the CLI past
    // MAXIMUM, or the API raising MINIMUM past the shipped CLI, must fail here.
    const cliVersionText = cliFile("src/generated/cli-version.ts");
    const cliVersion = /CLI_VERSION\s*=\s*"([^"]+)"/u.exec(cliVersionText)?.[1];
    if (cliVersion === undefined) {
      throw new Error(
        "could not read CLI_VERSION from generated cli-version.ts",
      );
    }
    const packageVersion = JSON.parse(cliFile("package.json"))
      .version as string;

    // Generated version stays in sync with the package manifest it is baked from.
    expect(cliVersion).toBe(packageVersion);

    // Band is well-formed and both the advertised "latest" and the packed CLI
    // fall inside it.
    expect(
      compareSemver(STELLA_CLI_MINIMUM_VERSION, STELLA_CLI_MAXIMUM_VERSION),
    ).toBeLessThanOrEqual(0);
    expect(
      compareSemver(STELLA_CLI_MINIMUM_VERSION, STELLA_CLI_LATEST_VERSION),
    ).toBeLessThanOrEqual(0);
    expect(
      compareSemver(STELLA_CLI_LATEST_VERSION, STELLA_CLI_MAXIMUM_VERSION),
    ).toBeLessThanOrEqual(0);
    expect(
      compareSemver(STELLA_CLI_MINIMUM_VERSION, cliVersion),
    ).toBeLessThanOrEqual(0);
    expect(
      compareSemver(cliVersion, STELLA_CLI_MAXIMUM_VERSION),
    ).toBeLessThanOrEqual(0);
  });
});

import { describe, expect, test } from "bun:test";

import {
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_SCOPES,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "../apps/api/src/mcp/constants";
import cliPackage from "../packages/cli/package.json" with { type: "json" };
import {
  CLI_DEFAULT_SCOPES,
  CLI_KNOWN_SCOPES,
  CLI_REQUIRED_RESOURCE_SCOPES,
  CLI_REQUIRED_SCOPES,
} from "../packages/cli/src/auth/constants";
import { CLI_SUPPORTED_API_CONTRACT_VERSION } from "../packages/cli/src/compatibility";

const expectSubset = (
  subset: readonly string[],
  superset: readonly string[],
) => {
  const available = new Set(superset);
  expect(subset.filter((value) => !available.has(value))).toEqual([]);
};

describe("API and CLI release contract", () => {
  test("the server advertises the contract version implemented by the CLI", () => {
    expect(STELLA_MCP_API_CONTRACT_VERSION).toBe(
      CLI_SUPPORTED_API_CONTRACT_VERSION,
    );
  });

  test("a CLI version bump cannot merge without server support", () => {
    expect(STELLA_CLI_MAXIMUM_VERSION).toBe(cliPackage.version);
    expect(
      Bun.semver.satisfies(
        cliPackage.version,
        `>=${STELLA_CLI_MINIMUM_VERSION} <=${STELLA_CLI_MAXIMUM_VERSION}`,
      ),
    ).toBe(true);
    expect(
      Bun.semver.satisfies(
        STELLA_CLI_LATEST_VERSION,
        `>=${STELLA_CLI_MINIMUM_VERSION} <=${STELLA_CLI_MAXIMUM_VERSION}`,
      ),
    ).toBe(true);
  });

  test("every packaged CLI scope is supported by the same API source", () => {
    expectSubset(CLI_KNOWN_SCOPES, MCP_OAUTH_SCOPES);
    expectSubset(CLI_REQUIRED_RESOURCE_SCOPES, MCP_DEFAULT_RESOURCE_SCOPES);
    expectSubset(CLI_DEFAULT_SCOPES, CLI_KNOWN_SCOPES);
    expectSubset(CLI_REQUIRED_SCOPES, CLI_DEFAULT_SCOPES);
  });
});

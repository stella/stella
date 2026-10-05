import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  clientUpgradeRequiredError,
  mcpClientAdmission,
  STELLA_CLI_CLIENT_NAME,
  STELLA_CLI_INSTALL_COMMAND,
  STELLA_CLI_MINIMUM_CONTRACT_VERSION,
} from "@/api/mcp/cli-client-admission";
import { STELLA_API_CONTRACT } from "@/api/mcp/constants";
import { MCP_ERROR_CODES } from "@/api/mcp/error-codes";

import { CLI_SUPPORTED_API_PROTOCOLS } from "../../../../packages/cli/src/generated/api-contract";
import { CLI_MCP_CLIENT_INFO } from "../../../../packages/cli/src/mcp-client";

// Every published release that sends `initialize`, with the protocols its
// generated contract supports. 0.1.0 through 0.3.0 send no handshake, so no
// identity exists to classify; 1.0.0 was never published.
const PUBLISHED_PROTOCOL_1_RELEASES = [
  "0.4.2",
  "0.4.3",
  "0.5.0",
  "0.6.0",
  "0.6.8",
  "0.7.2",
  "0.8.0",
  "0.10.0",
  "0.10.1",
] as const;
const PUBLISHED_PROTOCOL_2_RELEASES = ["1.1.0", "1.8.1", "1.19.2"] as const;

const NON_CLI_CLIENT_NAMES = [
  "claude-ai",
  "Claude Code",
  "openai-mcp",
  "chatgpt",
  "cursor-vscode",
  "mcp-inspector",
  "Stella-CLI",
  "stella-cli-dev",
  "stella",
] as const;

describe("stale Stella CLI admission", () => {
  test("refuses every published release that predates the live protocol", () => {
    for (const version of PUBLISHED_PROTOCOL_1_RELEASES) {
      expect(
        mcpClientAdmission({ name: STELLA_CLI_CLIENT_NAME, version }),
      ).toEqual({ kind: "client_upgrade_required", cliVersion: version });
    }
  });

  test("admits releases that speak the live protocol, prereleases included", () => {
    for (const version of [
      ...PUBLISHED_PROTOCOL_2_RELEASES,
      STELLA_CLI_MINIMUM_CONTRACT_VERSION,
      "1.0.0-rc.1",
      "3.8.6+build.7",
    ]) {
      expect(
        mcpClientAdmission({ name: STELLA_CLI_CLIENT_NAME, version }),
      ).toEqual({ kind: "admitted" });
    }
  });

  test("admits a Stella CLI whose version does not parse", () => {
    for (const version of ["dev", "", "v0.10.1", "0.10", "0.10.1.2", 10]) {
      expect(
        mcpClientAdmission({ name: STELLA_CLI_CLIENT_NAME, version }),
      ).toEqual({ kind: "admitted" });
    }
    expect(mcpClientAdmission({ name: STELLA_CLI_CLIENT_NAME })).toEqual({
      kind: "admitted",
    });
  });

  test("admits clients that report no identity", () => {
    for (const clientInfo of [undefined, null, "stella-cli", {}, []]) {
      expect(mcpClientAdmission(clientInfo)).toEqual({ kind: "admitted" });
    }
  });

  test("never refuses a client that does not name itself stella-cli", () => {
    for (const name of NON_CLI_CLIENT_NAMES) {
      expect(mcpClientAdmission({ name, version: "0.10.1" })).toEqual({
        kind: "admitted",
      });
    }
    assertProperty(
      "never refuses a client that does not name itself stella-cli",
      fc.property(
        fc.string().filter((name) => name.trim() !== STELLA_CLI_CLIENT_NAME),
        fc.oneof(
          fc.string(),
          fc
            .tuple(fc.nat(9), fc.nat(99), fc.nat(99))
            .map((parts) => parts.join(".")),
        ),
        (name, version) => {
          expect(mcpClientAdmission({ name, version })).toEqual({
            kind: "admitted",
          });
        },
      ),
    );
  });

  test("the refusal names the install command in its message and hint", () => {
    const error = clientUpgradeRequiredError("0.10.1");
    expect(MCP_ERROR_CODES).toContain(error.code);
    expect(error.code).toBe("client_upgrade_required");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("0.10.1");
    expect(error.message).toContain(STELLA_CLI_INSTALL_COMMAND);
    expect(error.hint).toContain(STELLA_CLI_INSTALL_COMMAND);
  });
});

// The pair the server and the CLI must agree on: the identity the current CLI
// sends, and the identity the server recognises. Renaming the client, changing
// the version shape, or bumping the protocol without a CLI that speaks it
// breaks this test rather than refusing (or silently admitting) real CLIs.
describe("CLI identity pair", () => {
  test("the server recognises the identity the current CLI sends", () => {
    expect(CLI_MCP_CLIENT_INFO.name).toBe(STELLA_CLI_CLIENT_NAME);
    // The recogniser reads this exact shape: the same identity carrying a
    // pre-contract version is refused, so admission below is not vacuous.
    expect(
      mcpClientAdmission({ ...CLI_MCP_CLIENT_INFO, version: "0.10.1" }),
    ).toEqual({ kind: "client_upgrade_required", cliVersion: "0.10.1" });
    expect(mcpClientAdmission(CLI_MCP_CLIENT_INFO)).toEqual({
      kind: "admitted",
    });
  });

  test("the current CLI speaks the live protocol under a version the recogniser parses", () => {
    expect(CLI_SUPPORTED_API_PROTOCOLS).toContain(STELLA_API_CONTRACT.protocol);
    // An unparseable version is admitted by design, which would make the
    // admission above pass for the wrong reason.
    expect(CLI_MCP_CLIENT_INFO.version).toMatch(/^\d+\.\d+\.\d+(?:[-+]|$)/u);
  });
});

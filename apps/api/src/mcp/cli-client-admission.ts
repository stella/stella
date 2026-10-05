import { panic } from "better-result";

import { sanitizeMcpClientIdentity } from "@/api/mcp/client-identity";
import { STELLA_API_CONTRACT } from "@/api/mcp/constants";

/**
 * The name every published Stella CLI that sends an MCP `initialize` gives in
 * `clientInfo` (0.4.2 onward; 0.1.0 through 0.3.0 posted bare `tools/call`
 * requests with no handshake and no identity, so nothing can name them).
 * Exact match only: other MCP clients name themselves differently and must
 * never be refused here.
 */
export const STELLA_CLI_CLIENT_NAME = "stella-cli";

export const STELLA_CLI_INSTALL_COMMAND = "npm i -g @stll/cli";

/**
 * The first CLI release whose `CLI_SUPPORTED_API_PROTOCOLS` contains each API
 * protocol. Protocol 2 shipped with 1.0.0 (#3102); every published 0.x release
 * supports protocol 1 only. Keyed by the live protocol, so bumping
 * `STELLA_API_CONTRACT.protocol` fails typecheck here until the first CLI
 * release that speaks the new protocol is named.
 */
const FIRST_CLI_VERSION_BY_PROTOCOL = {
  2: "1.0.0",
} as const satisfies Record<typeof STELLA_API_CONTRACT.protocol, string>;

export const STELLA_CLI_MINIMUM_CONTRACT_VERSION =
  FIRST_CLI_VERSION_BY_PROTOCOL[STELLA_API_CONTRACT.protocol];

// major.minor.patch with optional prerelease and build suffixes. Only the core
// is compared: a prerelease of an admitted core is admitted, so a refusal never
// rests on a suffix ordering a release may not follow.
const CLI_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const versionCore = (version: string): readonly number[] | undefined => {
  const matched = CLI_VERSION_PATTERN.exec(version);
  if (matched === null) {
    return undefined;
  }
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
};

const precedes = (
  left: readonly number[],
  right: readonly number[],
): boolean => {
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? 0;
    if (part !== other) {
      return part < other;
    }
  }
  return false;
};

const MINIMUM_CORE: readonly number[] =
  versionCore(STELLA_CLI_MINIMUM_CONTRACT_VERSION) ??
  panic(
    `cli-client-admission: "${STELLA_CLI_MINIMUM_CONTRACT_VERSION}" is not a CLI version`,
  );

export type McpClientAdmission =
  | { readonly kind: "admitted" }
  | {
      readonly kind: "client_upgrade_required";
      readonly cliVersion: string;
    };

/**
 * Whether a client may use this server, from the identity it reported. Only a
 * client that names itself `stella-cli` with a well-formed version older than
 * the first release speaking the live protocol is refused; any other name, a
 * missing identity, or a version that does not parse is admitted, because none
 * of them identifies a stale CLI precisely.
 */
export const mcpClientAdmission = (clientInfo: unknown): McpClientAdmission => {
  const { clientName, clientVersion } = sanitizeMcpClientIdentity(clientInfo);
  if (clientName !== STELLA_CLI_CLIENT_NAME || clientVersion === undefined) {
    return { kind: "admitted" };
  }
  const core = versionCore(clientVersion);
  if (core === undefined || !precedes(core, MINIMUM_CORE)) {
    return { kind: "admitted" };
  }
  return { kind: "client_upgrade_required", cliVersion: clientVersion };
};

/**
 * The agent-facing refusal. Published CLIs print only the error `message`, so
 * it carries the install command on its own; `hint` repeats it for clients
 * that render the envelope.
 */
export const clientUpgradeRequiredError = (cliVersion: string) =>
  ({
    code: "client_upgrade_required",
    message: `Stella CLI ${cliVersion} is too old for this server and must be upgraded. Run \`${STELLA_CLI_INSTALL_COMMAND}\`, then retry.`,
    hint: `Run \`${STELLA_CLI_INSTALL_COMMAND}\` to install the current Stella CLI (${STELLA_CLI_MINIMUM_CONTRACT_VERSION} or newer), then retry the command.`,
    retryable: false,
  }) as const;

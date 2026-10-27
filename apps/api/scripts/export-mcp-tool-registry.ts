// Dev-only exporter: projects the MCP tool registry
// (`DEFAULT_MCP_TOOL_DEFINITIONS`) down to the four `tools/list` wire fields and
// writes a JSON snapshot that `@stll/cli`'s codegen consumes.
//
// Why a snapshot instead of importing the registry from `@stll/cli` directly:
// `static-tool-definitions.ts` transitively imports `@/api/env`, which eagerly
// validates the full API environment (REDIS_URL, BETTER_AUTH_*, GOTENBERG_*,
// ...) at module load. Running that inside `apps/api` (where the env resolves)
// and emitting a plain JSON file keeps the published `@stll/cli` package free of
// any import — type or value — reachable from `apps/api`. Regenerate with
// `bun run codegen` from `packages/cli` (which runs this first, then the pure
// generator). The snapshot is committed, so registry drift shows up as a diff.

// Side-effect import, first: the tooling harness runs this as a local
// development process, which is what the registry projects (every feature
// gate open).
import "../src/tests/setup-env";
import { panic } from "better-result";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import {
  MCP_TOOL_NAME_MAX_LENGTH,
  MCP_TOOL_NAME_PATTERN,
} from "@stll/api-contract/mcp-tool-name";
import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";

import { WRITE_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { pickDefined } from "@/api/lib/pick-defined";
import { connectToolWeights } from "@/api/mcp/connect-tool-weights";
import {
  MCP_ADVANCED_DISCOVERY_PATH,
  MCP_ADVANCED_HTTP_PATH,
  MCP_ADVANCED_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
  STELLA_API_CONTRACT,
} from "@/api/mcp/constants";
import { MCP_ERROR_CODES } from "@/api/mcp/error-codes";
import { hasGrantedScope } from "@/api/mcp/gateway/static-tool-visibility";
import { listMcpResources } from "@/api/mcp/resources";
import { DEFAULT_MCP_CLI_ANNOTATIONS } from "@/api/mcp/static-cli-metadata";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  MODEL_VISIBLE_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import {
  MCP_CLI_TOOL_SCOPES,
  type McpCliToolAnnotation,
  type McpToolDefinition,
} from "@/api/mcp/tool-types";

type StaticMcpToolDefinition = (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number];

const deriveCliAnnotation = (
  tool: McpToolDefinition & { name: StaticMcpToolDefinition["name"] },
): McpCliToolAnnotation => {
  const declared = DEFAULT_MCP_CLI_ANNOTATIONS[tool.name];
  const annotation = {
    ...declared,
    ...pickDefined(tool, ["feature", "featureId"]),
  };
  const behavior =
    "destructiveBehavior" in tool ? tool.destructiveBehavior : undefined;
  if (behavior === undefined || behavior.type === "always") {
    return annotation;
  }

  if (behavior.type === "capability-catalog" || behavior.type === "outbound") {
    // The leaf prompts before it runs, and `--yes` pre-approves: a catalog
    // target decides its own risk at dispatch, and an outbound call is refused
    // by the same server-side gate a destructive one is.
    return { ...annotation, confirmPassthrough: true };
  }

  if (behavior.type === "upstream") {
    return panic(
      `${tool.name} static CLI metadata cannot use upstream behavior`,
    );
  }

  const discriminator = annotation.discriminator;
  if (discriminator === undefined || discriminator.prop !== behavior.property) {
    return panic(
      `${tool.name} CLI metadata must discriminate on ${behavior.property}`,
    );
  }

  return {
    ...annotation,
    discriminator: {
      ...discriminator,
      subcommands: Object.fromEntries(
        Object.entries(discriminator.subcommands).map(([value, subcommand]) => [
          value,
          {
            ...subcommand,
            destructive: behavior.destructiveValues.some(
              (destructiveValue) => destructiveValue === value,
            ),
          },
        ]),
      ),
    },
  };
};

// The tools/list wire fields plus build-time CLI metadata.
type RegistryToolListing = {
  cli: McpCliToolAnnotation;
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
};

const listings: RegistryToolListing[] = [];
for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
  listings.push({
    cli: deriveCliAnnotation(tool),
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  });
}

const snapshotPath = new URL(
  "../../../packages/cli/src/generated/registry-snapshot.json",
  import.meta.url,
);

await Bun.write(snapshotPath, `${JSON.stringify(listings, null, 2)}\n`);

process.stderr.write(
  `Wrote ${listings.length} tool listings to ${snapshotPath.pathname}\n`,
);

const connectWeightPath = new URL(
  "../mcp-connect-tool-weights.json",
  import.meta.url,
);
await Bun.write(
  connectWeightPath,
  `${JSON.stringify(connectToolWeights(listings), null, 2)}\n`,
);
process.stderr.write(`Wrote ${connectWeightPath.pathname}\n`);

const projectedChatPolicyKinds: Record<string, "internal" | "mutation"> = {};
const projectedChatGrantPolicies: Record<string, "approve-once" | "grantable"> =
  {};
for (const tool of MODEL_VISIBLE_MCP_TOOL_DEFINITIONS) {
  if (
    tool.access !== "write" ||
    !WRITE_TOOL_REF_FIELD_MAP[tool.name].chatProjectable
  ) {
    continue;
  }

  projectedChatPolicyKinds[tool.name] = "mutation";
  // Account-control changes need fresh consent even when they are reversible.
  projectedChatGrantPolicies[tool.name] =
    tool.accountAccess === ACCOUNT_ACCESS.accountControl ||
    tool.annotations.destructiveHint
      ? "approve-once"
      : "grantable";
}

const generatedChatPolicyPath = new URL(
  "../../../packages/api-contract/src/mcp-chat-tool-policy.gen.ts",
  import.meta.url,
);
const generatedChatPolicy = `// GENERATED by apps/api/scripts/export-mcp-tool-registry.ts. Do not edit by hand.\n\nexport const MCP_CHAT_TOOL_POLICY_KINDS = ${JSON.stringify(projectedChatPolicyKinds, null, 2)} as const;\n\nexport const MCP_CHAT_TOOL_GRANT_POLICIES = ${JSON.stringify(projectedChatGrantPolicies, null, 2)} as const;\n`;
await Bun.write(generatedChatPolicyPath, generatedChatPolicy);
process.stderr.write(`Wrote ${generatedChatPolicyPath.pathname}\n`);

// The resource surface (spec 051 S5.4) is generated the same way: project
// `resources/list` to its wire fields so the CLI's `reference` tree never drifts
// from the server's static resources. The set is mode-independent; export the
// default-mode projection.
type ResourceListing = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

const resourceListings: ResourceListing[] = [];
for (const resource of await listMcpResources("default")) {
  const listing: ResourceListing = { uri: resource.uri, name: resource.name };
  if (resource.title !== undefined) {
    listing.title = resource.title;
  }
  if (resource.description !== undefined) {
    listing.description = resource.description;
  }
  if (resource.mimeType !== undefined) {
    listing.mimeType = resource.mimeType;
  }
  resourceListings.push(listing);
}

const resourceSnapshotPath = new URL(
  "../../../packages/cli/src/generated/resources-snapshot.json",
  import.meta.url,
);

await Bun.write(
  resourceSnapshotPath,
  `${JSON.stringify(resourceListings, null, 2)}\n`,
);

process.stderr.write(
  `Wrote ${resourceListings.length} resource listings to ${resourceSnapshotPath.pathname}\n`,
);

// The published CLI cannot depend on the private workspace API-contract
// package. Copy this dependency-free transport contract verbatim into its
// committed generated tree instead. API, MCP App and CLI therefore compile
// from one source file, while the existing codegen-diff guard catches a stale
// CLI projection.
const uploadTransportSourcePath = new URL(
  "../../../packages/api-contract/src/document-version-upload.ts",
  import.meta.url,
);
const uploadTransportOutputPath = new URL(
  "../../../packages/cli/src/generated/document-version-upload-transport.ts",
  import.meta.url,
);
const uploadTransportSource = await Bun.file(uploadTransportSourcePath).text();
await Bun.write(
  uploadTransportOutputPath,
  `// GENERATED by \`bun run codegen\`. Do not edit by hand.\n${uploadTransportSource}`,
);
process.stderr.write(`Wrote ${uploadTransportOutputPath.pathname}\n`);

// Bake the API-owned compatibility contract into the CLI. Published CLIs keep
// their generated minimum revision while the server can advance independently;
// Changesets package-version bumps never touch this contract.
const apiContractOutputPath = new URL(
  "../../../packages/cli/src/generated/api-contract.ts",
  import.meta.url,
);
await Bun.write(
  apiContractOutputPath,
  `// GENERATED by \`bun run codegen\`. Do not edit by hand.

export const CLI_SUPPORTED_API_PROTOCOLS = [${STELLA_API_CONTRACT.protocol}] as const;
export const CLI_MINIMUM_SERVER_REVISION = ${STELLA_API_CONTRACT.revision};
export const CLI_REQUIRED_CAPABILITIES = ${JSON.stringify(STELLA_API_CONTRACT.capabilities, null, 2)} as const;
`,
);
process.stderr.write(`Wrote ${apiContractOutputPath.pathname}\n`);

// The CLI is published independently and cannot import the private API
// workspace. Generate its stable MCP wire constants from the API-owned values
// instead of maintaining handwritten mirrors guarded by source-text tests.
const mcpContractOutputPath = new URL(
  "../../../packages/cli/src/generated/mcp-contract.ts",
  import.meta.url,
);
const cliKnownScopes = [
  ...MCP_OAUTH_PROTOCOL_SCOPES,
  ...MCP_ADVANCED_RESOURCE_SCOPES,
];
await Bun.write(
  mcpContractOutputPath,
  `// GENERATED by \`bun run codegen\`. Do not edit by hand.

export const MCP_CAPABILITY_EXECUTORS = ${JSON.stringify(MCP_CAPABILITY_EXECUTORS, null, 2)} as const;
export const MCP_HTTP_PATH = ${JSON.stringify(MCP_ADVANCED_HTTP_PATH)} as const;
export const MCP_DISCOVERY_PATH = ${JSON.stringify(MCP_ADVANCED_DISCOVERY_PATH)} as const;
export const MCP_TOOL_NAME_MAX_LENGTH = ${MCP_TOOL_NAME_MAX_LENGTH};
export const MCP_TOOL_NAME_PATTERN_SOURCE = ${JSON.stringify(MCP_TOOL_NAME_PATTERN.source)} as const;
export const MCP_TOOL_NAME_PATTERN_FLAGS = ${JSON.stringify(MCP_TOOL_NAME_PATTERN.flags)} as const;
export const CLI_KNOWN_SCOPES = ${JSON.stringify(cliKnownScopes, null, 2)} as const;
export const CLI_REQUIRED_RESOURCE_SCOPES = ${JSON.stringify(MCP_ADVANCED_RESOURCE_SCOPES, null, 2)} as const;
export const MCP_ERROR_CODES = ${JSON.stringify(MCP_ERROR_CODES, null, 2)} as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
export const VERIFICATION_RUN_CAP_CODES = ${JSON.stringify(VERIFICATION_RUN_CAP_CODES, null, 2)} as const;
export type VerificationRunCapCode = (typeof VERIFICATION_RUN_CAP_CODES)[keyof typeof VERIFICATION_RUN_CAP_CODES];
export const ACTION_ADMISSION_REFUSALS = ${JSON.stringify(ACTION_ADMISSION_REFUSALS, null, 2)} as const;
export type ActionAdmissionCode = keyof typeof ACTION_ADMISSION_REFUSALS;
export const MCP_CLI_TOOL_SCOPES = ${JSON.stringify(MCP_CLI_TOOL_SCOPES, null, 2)} as const;
export const MCP_SCOPE_IMPLICATIONS = ${JSON.stringify(
    MCP_ADVANCED_RESOURCE_SCOPES.flatMap((grant) =>
      MCP_ADVANCED_RESOURCE_SCOPES.filter(
        (scope) => scope !== grant && hasGrantedScope([grant], scope),
      ).map((scope) => ({ grant, scope })),
    ),
    null,
    2,
  )} as const;
export type McpCliToolScope = (typeof MCP_CLI_TOOL_SCOPES)[number];
`,
);
process.stderr.write(`Wrote ${mcpContractOutputPath.pathname}\n`);

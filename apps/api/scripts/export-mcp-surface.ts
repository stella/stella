// Export the first-party tool contracts using the same schema projection as
// tools/list. The artifact covers the static registry at every feature setting.
// Session permissions and tenant-owned connectors, skills and configuration
// are supplied by the service at request time. Copy this script into a release
// predating the asset to generate it from that release's own registry.
import "../src/tests/setup-env";
import { panic } from "better-result";

import { toSafeId } from "@/api/lib/branded-types";
import type { FeatureGrant } from "@/api/lib/feature-access/grants-schema";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { MCP_MODES } from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import {
  isMcpDescriptorFeatureEnabled,
  type McpFeatureAccessContext,
  projectMcpFeatureInput,
} from "@/api/mcp/feature-access";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { CAPABILITY_FEATURE_BINDINGS } from "@/api/mcp/generated/capability-feature-bindings";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

const principal = {
  organizationId: toSafeId<"organization">("mcp-surface-export-org"),
  userId: toSafeId<"user">("mcp-surface-export-user"),
};

function* featureSets(
  features: readonly string[],
  enabled: readonly string[] = [],
): Generator<readonly string[]> {
  yield enabled;
  for (const [index, feature] of features.entries()) {
    yield* featureSets(features.slice(index + 1), [...enabled, feature]);
  }
}

const featureSnapshot = (
  featureIds: readonly string[],
  enabled: readonly string[],
) => {
  const grant = {
    type: "organization",
    organizationId: principal.organizationId,
  } satisfies FeatureGrant;
  const grants = Object.fromEntries(enabled.map((id) => [id, [grant]]));
  const enrolments = enabled.map((featureId) => ({ ...principal, featureId }));
  const available = new Set(enabled);
  return createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map(
      featureIds.map((featureId) => [
        featureId,
        decideFeatureAccess({
          ...principal,
          registry: FEATURE_REGISTRY,
          grants,
          featureId,
          user: {
            email: "mcp-surface-export@example.com",
            emailVerified: true,
          },
          membership: true,
          enrolments,
          // A profile represents the features this deployment makes available
          // and for which the verified principal has the necessary grants.
          deploymentEnabled: [
            ...featurePrerequisiteClosure(FEATURE_REGISTRY, featureId),
          ].every((id) => available.has(id)),
        }),
      ]),
    ),
  });
};

const projectTools = ({
  context,
  mode,
  tools,
}: {
  context: McpFeatureAccessContext;
  mode: McpMode;
  tools: readonly McpToolDefinition[];
}) => {
  const featureByName = new Map(
    tools.map(({ name, feature }) => [name, feature]),
  );
  const offered = tools
    .filter(({ name, featureId }) =>
      isMcpDescriptorFeatureEnabled({
        context,
        kind: "tools",
        id: name,
        featureId,
      }),
    )
    .map((tool) => projectMcpFeatureInput(context, tool));

  return toMcpTools(offered, { mode, context }).map(
    ({ name, inputSchema, outputSchema }) => {
      const feature = featureByName.get(name);
      return {
        name,
        inputSchema,
        ...(outputSchema === undefined ? {} : { outputSchema }),
        ...(feature === undefined ? {} : { feature }),
      };
    },
  );
};

const exportMcpSurface = () => {
  const modeDefinitions = MCP_MODES.map(
    (mode) => [mode, listStaticMcpToolDefinitions(mode)] as const,
  );
  const allDefinitions: readonly McpToolDefinition[] = [
    ...modeDefinitions.flatMap(([, tools]) => tools),
    ...DEFAULT_MCP_TOOL_DEFINITIONS,
  ];
  // The wire serializer scopes prose and schema enums against hidden tools
  // from the default registry and capabilities even in restricted modes.
  const descriptorFeatures = [
    ...CAPABILITY_FEATURE_BINDINGS.values(),
    ...allDefinitions.flatMap(({ featureId, featureInput }) =>
      [featureId, featureInput?.featureId].filter((id) => id !== undefined),
    ),
  ];
  const featureIds = [
    ...new Set(
      descriptorFeatures.flatMap((id) => [
        ...featurePrerequisiteClosure(FEATURE_REGISTRY, id),
      ]),
    ),
  ].toSorted();
  const featureProfiles = Array.from(featureSets(featureIds), (enabled) => ({
    key: enabled.join(","),
    context: {
      ...principal,
      featureAccessSnapshot: featureSnapshot(featureIds, enabled),
    },
  }));

  // Most profiles advertise identical schemas for each tool. Intern the
  // variants once while retaining each profile's tools/list ordering. A tool
  // variant's deployment flag is independent of its schema projection.
  const tools: ReturnType<typeof projectTools> = [];
  const indexByVariant = new Map<string, number>();
  const modes = Object.fromEntries(
    modeDefinitions.map(([mode, definitions]) => {
      const profiles = new Map<string, number[]>();
      for (const { key, context } of featureProfiles) {
        const projected = projectTools({ context, mode, tools: definitions });
        const indexes = projected.map((tool) => {
          const variant = JSON.stringify(tool);
          const existing = indexByVariant.get(variant);
          if (existing !== undefined) {
            return existing;
          }
          const index = tools.length;
          tools.push(tool);
          indexByVariant.set(variant, index);
          return index;
        });
        profiles.set(key, indexes);
      }
      return [mode, Object.fromEntries(profiles)];
    }),
  );
  return { tools, modes };
};

if (import.meta.main) {
  const output = Bun.argv.at(2);
  if (output === undefined) {
    panic("Usage: bun scripts/export-mcp-surface.ts <output-file>");
  }
  await Bun.write(output, `${JSON.stringify(exportMcpSurface())}\n`);
  // The API registry owns handles that survive the export.
  process.exit(0);
}

import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

export type McpFeatureAccessBindings = {
  capabilities: ReadonlyMap<string, string>;
  tools: ReadonlyMap<string, string>;
  resources: ReadonlyMap<string, string>;
};

export type McpFeatureAccessContext = {
  featureAccessSnapshot?: McpRequestContext["featureAccessSnapshot"];
  testDependencies?: McpRequestContext["testDependencies"];
} & Partial<Pick<McpRequestContext, "organizationId" | "userId">>;

type McpDescriptorFeatureArgs = {
  context: McpFeatureAccessContext | undefined;
  kind: keyof McpFeatureAccessBindings;
  id: string;
  featureId?: string | undefined;
};

export const resolveMcpDescriptorFeatureId = ({
  context,
  kind,
  id,
  featureId,
}: McpDescriptorFeatureArgs): string | undefined =>
  context?.testDependencies?.featureAccessBindings?.[kind].get(id) ?? featureId;

export const isMcpDescriptorFeatureEnabled = (
  args: McpDescriptorFeatureArgs,
): boolean => {
  const featureId = resolveMcpDescriptorFeatureId(args);
  if (featureId === undefined) {
    return true;
  }
  const snapshot =
    args.context?.testDependencies?.featureAccessSnapshot ??
    args.context?.featureAccessSnapshot;
  if (
    snapshot === undefined ||
    args.context?.organizationId === undefined ||
    args.context.userId === undefined
  ) {
    return false;
  }
  return isFeatureEnabled(snapshot, featureId, {
    organizationId: args.context.organizationId,
    userId: args.context.userId,
  });
};

/** Mixed tools keep their ordinary operations while projecting unavailable feature inputs. */
export const projectMcpFeatureInput = (
  context: McpFeatureAccessContext | undefined,
  definition: McpToolDefinition,
): McpToolDefinition => {
  const input = definition.featureInput;
  if (
    input === undefined ||
    isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: definition.name,
      featureId: input.featureId,
    })
  ) {
    return definition;
  }
  return {
    ...definition,
    description: input.unavailableDescription,
    inputSchema: input.projectInputSchema(definition.inputSchema),
  };
};

type McpFeatureInputAccessOptions = {
  context: McpFeatureAccessContext | undefined;
  definition: McpToolDefinition;
  args: unknown;
};

/** Admission and discovery share the same conditional feature declaration. */
export const isMcpFeatureInputEnabled = ({
  context,
  definition,
  args,
}: McpFeatureInputAccessOptions): boolean => {
  const input = definition.featureInput;
  return (
    input === undefined ||
    !input.usesFeature(args) ||
    isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: definition.name,
      featureId: input.featureId,
    })
  );
};

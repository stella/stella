import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type { McpRequestContext } from "@/api/mcp/context";

export type McpFeatureAccessBindings = {
  capabilities: ReadonlyMap<string, string>;
  tools: ReadonlyMap<string, string>;
  resources: ReadonlyMap<string, string>;
};

export type McpFeatureAccessContext = Pick<
  McpRequestContext,
  "featureAccessSnapshot" | "testDependencies"
> &
  Partial<Pick<McpRequestContext, "organizationId" | "userId">>;

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

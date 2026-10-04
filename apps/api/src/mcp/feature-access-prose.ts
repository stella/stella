import { isRecord } from "@/api/lib/type-guards";
import {
  isMcpDescriptorFeatureEnabled,
  type McpFeatureAccessContext,
} from "@/api/mcp/feature-access";
import { CAPABILITY_FEATURE_BINDINGS } from "@/api/mcp/generated/capability-feature-bindings";

export const hiddenMcpDescriptorIds = (
  context: McpFeatureAccessContext | undefined,
  definitions: readonly { name: string; featureId?: string | undefined }[],
): ReadonlySet<string> =>
  new Set([
    ...definitions
      .filter(
        (definition) =>
          !isMcpDescriptorFeatureEnabled({
            context,
            kind: "tools",
            id: definition.name,
            featureId: definition.featureId,
          }),
      )
      .map(({ name }) => name),
    ...Array.from(
      new Map([
        ...CAPABILITY_FEATURE_BINDINGS,
        ...(context?.testDependencies?.featureAccessBindings?.capabilities ??
          []),
      ]).entries(),
    )
      .filter(
        ([id, featureId]) =>
          !isMcpDescriptorFeatureEnabled({
            context,
            kind: "capabilities",
            id,
            featureId,
          }),
      )
      .map(([id]) => id),
  ]);

export const scopeMcpDescriptorProse = (
  text: string,
  hiddenIds: ReadonlySet<string>,
): string => {
  if (![...hiddenIds].some((id) => text.includes(id))) {
    return text;
  }
  return text
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => ![...hiddenIds].some((id) => sentence.includes(id)))
    .join(" ");
};

const containsHiddenMcpDescriptorId = (
  value: unknown,
  hiddenIds: ReadonlySet<string>,
): boolean => {
  if (typeof value === "string") {
    return [...hiddenIds].some((id) => value.includes(id));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsHiddenMcpDescriptorId(item, hiddenIds));
  }
  if (isRecord(value)) {
    return Object.values(value).some((item) =>
      containsHiddenMcpDescriptorId(item, hiddenIds),
    );
  }
  return false;
};

export const scopeSchemaAnnotations = (
  schema: Record<string, unknown>,
  hiddenIds: ReadonlySet<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === "description" && typeof value === "string") {
        return [[key, scopeMcpDescriptorProse(value, hiddenIds)]];
      }
      if ((key === "examples" || key === "enum") && Array.isArray(value)) {
        return [
          [
            key,
            value.filter(
              (item) => !containsHiddenMcpDescriptorId(item, hiddenIds),
            ),
          ],
        ];
      }
      if (
        key === "example" &&
        containsHiddenMcpDescriptorId(value, hiddenIds)
      ) {
        return [];
      }
      return [[key, scopeSchemaValue(value, hiddenIds)]];
    }),
  );
const scopeSchemaValue = (
  value: unknown,
  hiddenIds: ReadonlySet<string>,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => scopeSchemaValue(item, hiddenIds));
  }
  if (isRecord(value)) {
    return scopeSchemaAnnotations(value, hiddenIds);
  }
  return value;
};

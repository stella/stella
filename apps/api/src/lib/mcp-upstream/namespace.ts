/**
 * Every dynamically resolved tool family, keyed by the name prefix its tools
 * carry on the wire. Policy maps over dynamic tools (output contracts,
 * annotations, submission justifications) are keyed by this union, so a new
 * family cannot be namespaced here without each decision being made.
 */
export const DYNAMIC_TOOL_NAMESPACES = {
  external_mcp: "mcp",
  skill: "skill",
} as const;

export type DynamicToolNamespace = keyof typeof DYNAMIC_TOOL_NAMESPACES;

const NAMESPACE_SEPARATOR = "__";

export const dynamicToolNamespacePrefix = (
  namespace: DynamicToolNamespace,
): string => `${DYNAMIC_TOOL_NAMESPACES[namespace]}${NAMESPACE_SEPARATOR}`;

export const dynamicToolNamespaceOf = (
  toolName: string,
): DynamicToolNamespace | undefined => {
  for (const namespace of Object.keys(DYNAMIC_TOOL_NAMESPACES)) {
    if (
      isDynamicToolNamespace(namespace) &&
      toolName.startsWith(dynamicToolNamespacePrefix(namespace))
    ) {
      return namespace;
    }
  }
  return undefined;
};

export const isDynamicToolNamespace = (
  value: string,
): value is DynamicToolNamespace =>
  Object.hasOwn(DYNAMIC_TOOL_NAMESPACES, value);

export const isExternalMcpToolName = (toolName: string): boolean =>
  dynamicToolNamespaceOf(toolName) === "external_mcp";

export const isSkillToolName = (toolName: string): boolean =>
  dynamicToolNamespaceOf(toolName) === "skill";

export const sanitizeToolNamePart = (value: string): string => {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return sanitized.length > 0 ? sanitized : "tool";
};

export const shortToolNameHash = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);

export const namespaceMcpToolName = ({
  connectorSlug,
  toolName,
}: {
  connectorSlug: string;
  toolName: string;
}): string =>
  [
    DYNAMIC_TOOL_NAMESPACES.external_mcp,
    sanitizeToolNamePart(connectorSlug),
    sanitizeToolNamePart(toolName),
  ].join(NAMESPACE_SEPARATOR);

export const namespaceSkillToolName = (skillSlug: string): string =>
  [DYNAMIC_TOOL_NAMESPACES.skill, sanitizeToolNamePart(skillSlug)].join(
    NAMESPACE_SEPARATOR,
  );

export const collisionSafeToolName = ({
  baseName,
  rawName,
  seen,
}: {
  baseName: string;
  rawName: string;
  seen: Set<string>;
}): string => {
  if (!seen.has(baseName)) {
    seen.add(baseName);
    return baseName;
  }

  const hashedName = `${baseName}_${shortToolNameHash(rawName)}`;
  if (!seen.has(hashedName)) {
    seen.add(hashedName);
    return hashedName;
  }

  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${hashedName}_${attempt}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }

  return `${hashedName}_${Bun.randomUUIDv7().slice(0, 8)}`;
};

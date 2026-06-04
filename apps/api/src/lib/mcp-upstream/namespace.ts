const MCP_TOOL_PREFIX = "mcp";
const SKILL_TOOL_PREFIX = "skill";

export const isExternalMcpToolName = (toolName: string): boolean =>
  toolName.startsWith(`${MCP_TOOL_PREFIX}__`);

export const isSkillToolName = (toolName: string): boolean =>
  toolName.startsWith(`${SKILL_TOOL_PREFIX}__`);

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
    MCP_TOOL_PREFIX,
    sanitizeToolNamePart(connectorSlug),
    sanitizeToolNamePart(toolName),
  ].join("__");

export const namespaceSkillToolName = (skillSlug: string): string =>
  [SKILL_TOOL_PREFIX, sanitizeToolNamePart(skillSlug)].join("__");

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

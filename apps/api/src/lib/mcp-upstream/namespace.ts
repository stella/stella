import { panic } from "better-result";

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

/**
 * Every exposed tool name: lowercase ASCII letters, digits and underscores,
 * starting with a letter, at most 64 characters. Clients validate fetched
 * listings against exactly this (the CLI rejects the whole listing on one
 * miss), so every derivation below ends in `fitToolName`.
 */
export const TOOL_NAME_MAX_LENGTH = 64;
export const TOOL_NAME_PATTERN: RegExp = /^[a-z][a-z0-9_]{0,63}$/u;

const TOOL_NAME_HASH_LENGTH = 8;

export const sanitizeToolNamePart = (value: string): string => {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_]/gu, "_");
  return sanitized.length > 0 ? sanitized : "tool";
};

export const shortToolNameHash = (value: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")
    .slice(0, TOOL_NAME_HASH_LENGTH);

/**
 * Clips a derived name to the length limit. A clipped name ends in a hash of
 * the unclipped source, so two sources sharing a long prefix stay distinct.
 */
const fitToolName = ({
  name,
  rawName,
}: {
  name: string;
  rawName: string;
}): string =>
  name.length <= TOOL_NAME_MAX_LENGTH
    ? name
    : `${name.slice(0, TOOL_NAME_MAX_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}_${shortToolNameHash(rawName)}`;

export const namespaceMcpToolName = ({
  connectorSlug,
  toolName,
}: {
  connectorSlug: string;
  toolName: string;
}): string =>
  fitToolName({
    name: [
      DYNAMIC_TOOL_NAMESPACES.external_mcp,
      sanitizeToolNamePart(connectorSlug),
      sanitizeToolNamePart(toolName),
    ].join(NAMESPACE_SEPARATOR),
    rawName: `${connectorSlug}${NAMESPACE_SEPARATOR}${toolName}`,
  });

export const namespaceSkillToolName = (skillSlug: string): string =>
  fitToolName({
    name: [DYNAMIC_TOOL_NAMESPACES.skill, sanitizeToolNamePart(skillSlug)].join(
      NAMESPACE_SEPARATOR,
    ),
    rawName: skillSlug,
  });

/**
 * Claims a unique exposed name in `seen`. `hashFirst` skips the bare base name
 * when several sources share it, so which one keeps it never depends on order.
 */
export const collisionSafeToolName = ({
  baseName,
  hashFirst = false,
  rawName,
  seen,
}: {
  baseName: string;
  hashFirst?: boolean;
  rawName: string;
  seen: Set<string>;
}): string => {
  // A suffixed candidate may exceed the limit; clipping hashes the candidate
  // itself, so each attempt still fits and stays distinct.
  const claim = (candidate: string): string | undefined => {
    const fitted = fitToolName({ name: candidate, rawName: candidate });
    if (seen.has(fitted)) {
      return undefined;
    }
    seen.add(fitted);
    return fitted;
  };

  const claimed = hashFirst ? undefined : claim(baseName);
  if (claimed !== undefined) {
    return claimed;
  }

  const hashedName = `${baseName}_${shortToolNameHash(rawName)}`;
  const hashed = claim(hashedName);
  if (hashed !== undefined) {
    return hashed;
  }

  for (let attempt = 2; attempt < 100; attempt += 1) {
    const numbered = claim(`${hashedName}_${attempt}`);
    if (numbered !== undefined) {
      return numbered;
    }
  }

  return (
    claim(`${hashedName}_${Bun.randomUUIDv7().slice(-8)}`) ??
    panic("tool name space exhausted")
  );
};

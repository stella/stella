const PLUGIN_PREFIX_RE = /^@stll\/plugin-/

export const namespaceTool = (pluginId: string, toolName: string): string => {
  const prefix = pluginId.replace(PLUGIN_PREFIX_RE, "").replace("/", "_")
  return `${prefix}_${toolName}`
}

export const resolveTool = (
  namespacedName: string,
  availableTools: string[],
): string | null => {
  if (availableTools.includes(namespacedName)) return namespacedName
  const withoutPrefix = namespacedName.split("_").slice(1).join("_")
  return availableTools.includes(withoutPrefix) ? withoutPrefix : null
}

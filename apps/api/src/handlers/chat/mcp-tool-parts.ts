export const isExternalMcpToolPart = (part: unknown): boolean => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return false;
  }

  const type = part.type;
  if (typeof type !== "string") {
    return false;
  }

  if (type.startsWith("tool-mcp__")) {
    return true;
  }

  return (
    type === "dynamic-tool" &&
    "toolName" in part &&
    typeof part.toolName === "string" &&
    part.toolName.startsWith("mcp__")
  );
};

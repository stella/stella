export const isExternalMcpToolPart = (part: unknown): boolean => {
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    !("name" in part)
  ) {
    return false;
  }

  return (
    part.type === "tool-call" &&
    typeof part.name === "string" &&
    part.name.startsWith("mcp__")
  );
};

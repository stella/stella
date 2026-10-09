const MAX_CAUSE_DEPTH = 10;

const describeLink = (value: unknown) => {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  return typeof value === "string" ? value : Bun.inspect(value);
};

// Total by construction: it only reads `name`, `message` and `cause`, guards
// cycles and depth, and stringifies non-Error causes, so reporting a failure
// can never replace that failure with a new one.
export const formatErrorChain = (error: unknown) => {
  const seen = new Set<unknown>();
  const lines: string[] = [];
  let current = error;
  while (
    current !== undefined &&
    !seen.has(current) &&
    lines.length < MAX_CAUSE_DEPTH
  ) {
    seen.add(current);
    lines.push(
      lines.length === 0
        ? describeLink(current)
        : `  caused by: ${describeLink(current)}`,
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join("\n");
};

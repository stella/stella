import { Result } from "better-result";

const MAX_CAUSE_DEPTH = 10;
const UNREADABLE = "<unreadable>";
const UNREADABLE_CAUSE = "<unreadable cause>";

// Error properties can be getters that throw; a failed read becomes a
// placeholder so formatting never replaces the failure it reports.
const describeLink = (value: unknown) => {
  if (value instanceof Error) {
    const name = Result.try(() => value.name).unwrapOr(UNREADABLE);
    const message = Result.try(() => value.message).unwrapOr(UNREADABLE);
    return `${name}: ${message}`;
  }
  return typeof value === "string"
    ? value
    : Result.try(() => Bun.inspect(value)).unwrapOr(UNREADABLE);
};

const readCause = (value: unknown) =>
  value instanceof Error
    ? Result.try(() => value.cause).unwrapOr(UNREADABLE_CAUSE)
    : undefined;

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
    current = readCause(current);
  }
  return lines.join("\n");
};

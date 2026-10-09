import { Result } from "better-result";

const MAX_CAUSE_DEPTH = 10;
const UNREADABLE = "<unreadable>";
const UNREADABLE_CAUSE = "<unreadable cause>";

// Error properties can be getters that throw; a failed read becomes a
// placeholder so formatting never replaces the failure it reports.
const readOr = <T>(read: () => T, placeholder: T) =>
  Result.try({ try: read, catch: () => placeholder }).unwrapOr(placeholder);

const describeLink = (value: unknown) => {
  if (value instanceof Error) {
    const name = readOr(() => String(value.name), UNREADABLE);
    const message = readOr(() => String(value.message), UNREADABLE);
    return `${name}: ${message}`;
  }
  return typeof value === "string"
    ? value
    : readOr(() => Bun.inspect(value), UNREADABLE);
};

const readCause = (value: unknown) =>
  value instanceof Error
    ? readOr<unknown>(() => value.cause, UNREADABLE_CAUSE)
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

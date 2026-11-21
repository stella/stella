// Recognises the one load failure the entry point turns into a message: a
// bare package that does not resolve, which in a source checkout means the
// install step was skipped. A missing relative module is a broken build, not a
// missing install, and stays a real error. Imports nothing, so it loads when
// nothing else can.

const MISSING_PACKAGE = /^Cannot find package '([^']+)'/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The one-line message for a missing package, or null for any other error. */
export const missingDependencyMessage = (error: unknown): string | null => {
  if (!isRecord(error) || error["code"] !== "ERR_MODULE_NOT_FOUND") {
    return null;
  }
  const message = error["message"];
  const found =
    typeof message === "string" ? MISSING_PACKAGE.exec(message) : null;
  const specifier = found?.[1];
  if (
    specifier === undefined ||
    specifier.startsWith(".") ||
    specifier.startsWith("/")
  ) {
    return null;
  }
  return `Dependencies are missing (cannot load ${specifier}): run \`bun install\` first.`;
};

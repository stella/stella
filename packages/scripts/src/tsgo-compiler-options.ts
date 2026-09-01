import ts from "typescript";

/**
 * Compiler options the native checker (tsgo) accepts but the JavaScript
 * `typescript` package does not know, so its config parser reports them as
 * unknown. The repository compiles with tsgo, so these are valid configuration;
 * scripts that validate a tsconfig with the JavaScript parser have to excuse
 * them by name or every project in the repository reads as invalid.
 *
 * Excusing by name, not by diagnostic code: a genuine typo still fails.
 */
export const TSGO_ONLY_COMPILER_OPTIONS = [
  "checkers",
  "singleThreaded",
] as const;

/** `Unknown_compiler_option_0` and its `Did_you_mean_1` variant. */
const UNKNOWN_COMPILER_OPTION_CODES: ReadonlySet<number> = new Set([
  5023, 5025,
]);

export const isTsgoOnlyOptionDiagnostic = (
  diagnostic: ts.Diagnostic,
): boolean => {
  if (!UNKNOWN_COMPILER_OPTION_CODES.has(diagnostic.code)) {
    return false;
  }
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return TSGO_ONLY_COMPILER_OPTIONS.some((option) =>
    message.startsWith(`Unknown compiler option '${option}'`),
  );
};

export const withoutTsgoOnlyOptionDiagnostics = (
  diagnostics: readonly ts.Diagnostic[],
): ts.Diagnostic[] =>
  diagnostics.filter((diagnostic) => !isTsgoOnlyOptionDiagnostic(diagnostic));

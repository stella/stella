import { panic } from "better-result";
import path from "node:path";

/**
 * The `PATH` a turn's harness starts with: the tools the desktop manages ahead
 * of what the harness inherits, which stays. Without tools nothing is set.
 *
 * A launch's `environment` replaces a variable's whole value, so this reads the
 * value it extends. Windows names the variable in any case and a process must
 * not end up with two, so the name the base already uses is kept.
 */
export const toolPathEnvironment = (
  base: Readonly<Record<string, string>>,
  toolPath: readonly string[],
  delimiter: string = path.delimiter,
): Record<string, string> => {
  if (toolPath.length === 0) {
    return {};
  }
  if (toolPath.some((directory) => !path.isAbsolute(directory))) {
    panic("Tool path: a tool directory must be an absolute path");
  }
  const name =
    delimiter === ";"
      ? (Object.keys(base).find((key) => key.toUpperCase() === "PATH") ??
        "Path")
      : "PATH";
  const inherited = base[name];
  return {
    [name]: [...toolPath, ...(inherited ? [inherited] : [])].join(delimiter),
  };
};

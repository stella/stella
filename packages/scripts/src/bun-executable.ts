export const bunExecutable = (): string =>
  process.versions["bun"] === undefined ? "bun" : process.execPath;

export const bunxCommand = (args: readonly string[]): string[] =>
  process.versions["bun"] === undefined
    ? ["bunx", ...args]
    : [bunExecutable(), "x", ...args];

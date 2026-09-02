// `--server` is the one flag that must be read before stricli parses anything:
// startup resolves the origin (and the credential bound to it) to build the
// context every command runs with. Scanning argv here keeps the flag a global
// concern instead of a per-command hand-wire, and the value still reaches
// stricli normally, so `--help` documents it and the parser accepts it.

import { RESERVED_FLAG_KEYS } from "./reserved-flag-keys.js";

const SERVER_FLAG = `--${RESERVED_FLAG_KEYS.server}`;

/**
 * The `--server <url>` / `--server=<url>` value in `argv`, or `undefined` when
 * it is absent or unusable. Everything after a bare `--` is a positional
 * argument, never a flag. A missing or flag-shaped value is left for stricli to
 * report as the usage error it is, rather than resolved as an origin here.
 */
export const preparseServerFlag = (
  argv: readonly string[],
): string | undefined => {
  for (const [index, arg] of argv.entries()) {
    if (arg === "--") {
      return undefined;
    }
    if (arg === SERVER_FLAG) {
      const value = argv[index + 1];
      return value === undefined || value.startsWith("-") ? undefined : value;
    }
    if (arg.startsWith(`${SERVER_FLAG}=`)) {
      const value = arg.slice(SERVER_FLAG.length + 1);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
};

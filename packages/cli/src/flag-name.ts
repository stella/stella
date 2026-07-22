import type { FlagSpec } from "./route-types.js";

/** Stricli record key derived from the canonical public `--flag-name`. */
export const flagKey = (spec: Pick<FlagSpec, "flag">): string =>
  spec.flag
    .slice(2)
    .replace(/[._-](?<char>[a-z0-9])/gu, (_match, char: string) =>
      char.toUpperCase(),
    );

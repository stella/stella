// Shared `~/.config/stella` (XDG) directory resolution, used by both
// `cli-config.ts` (non-secret config) and `credential-store.ts` (secrets).

import os from "node:os";
import path from "node:path";

import { XDG_CONFIG_HOME } from "../env.js";

export type ConfigPathOverrides = {
  readonly xdgConfigHome?: string | undefined;
  readonly homeDir: string;
};

/** `$XDG_CONFIG_HOME/stella` or `~/.config/stella`, per the XDG base dir spec. */
export const resolveConfigDir = (overrides: ConfigPathOverrides): string => {
  const base =
    overrides.xdgConfigHome && overrides.xdgConfigHome.length > 0
      ? overrides.xdgConfigHome
      : path.join(overrides.homeDir, ".config");
  return path.join(base, "stella");
};

export const defaultConfigDir = (): string =>
  resolveConfigDir({
    homeDir: os.homedir(),
    xdgConfigHome: XDG_CONFIG_HOME,
  });

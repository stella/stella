import { panic } from "better-result";
import path from "node:path";

/**
 * Where package managers a local run starts keep their caches and downloads:
 * the chat's own stella-owned cache folder, which every harness sandbox may
 * write to and no other chat's run sees. Without it a sandboxed `bun
 * install`, `pip install` or a browser download would try to write to the
 * user's home and be refused.
 *
 * The one list both harness adapters set; each variable names its own
 * subfolder so tools never share a layout. The temp directory is not set
 * here: each harness keeps its own writable `TMPDIR` inside its sandbox.
 */
export const PACKAGE_CACHE_FOLDERS = {
  BUN_INSTALL_CACHE_DIR: "bun",
  npm_config_cache: "npm",
  PIP_CACHE_DIR: "pip",
  UV_CACHE_DIR: "uv",
  PLAYWRIGHT_BROWSERS_PATH: "ms-playwright",
  XDG_CACHE_HOME: "xdg",
} as const;

/** The variables that point a run's package managers into `cacheDir`. */
export const packageCacheEnvironment = (
  cacheDir: string,
): Record<string, string> => {
  if (!path.isAbsolute(cacheDir)) {
    panic("Package cache: the cache directory must be an absolute path");
  }
  return Object.fromEntries(
    Object.entries(PACKAGE_CACHE_FOLDERS).map(([name, folder]) => [
      name,
      path.join(cacheDir, folder),
    ]),
  );
};

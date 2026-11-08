import { describe, expect, test } from "bun:test";

import { packageCacheEnvironment } from "./package-cache";

describe("package cache environment", () => {
  test("points each package manager at its own folder inside the cache", () => {
    expect(packageCacheEnvironment("/data/agent-package-cache")).toEqual({
      BUN_INSTALL_CACHE_DIR: "/data/agent-package-cache/bun",
      npm_config_cache: "/data/agent-package-cache/npm",
      PIP_CACHE_DIR: "/data/agent-package-cache/pip",
      UV_CACHE_DIR: "/data/agent-package-cache/uv",
      PLAYWRIGHT_BROWSERS_PATH: "/data/agent-package-cache/ms-playwright",
      XDG_CACHE_HOME: "/data/agent-package-cache/xdg",
    });
  });

  test("leaves the temp directory to each harness's sandbox", () => {
    expect(Object.keys(packageCacheEnvironment("/cache"))).not.toContain(
      "TMPDIR",
    );
  });

  test("refuses a relative cache directory", () => {
    expect(() => packageCacheEnvironment("cache")).toThrow(
      "must be an absolute path",
    );
  });
});

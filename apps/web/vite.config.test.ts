import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createLogger, type ConfigEnv, type UserConfig } from "vite";

import config, {
  capViteLogger,
  REACT_PLUGIN_EXCLUDE,
  rewriteBrowserApiPath,
} from "./vite.config";

const PRAGMATIC_IMPORT_PREFIX = "@atlaskit/pragmatic-";
const DRAG_RUNTIME_SOURCE_ROOTS = [
  path.resolve(import.meta.dirname, "src"),
  path.resolve(import.meta.dirname, "../../packages/ui/src"),
  path.resolve(import.meta.dirname, "../../packages/workspace-ui/src"),
];
const runtimeDragImports = () => {
  const imports = new Set<string>();
  const sourceFiles = new Bun.Glob("**/*.{ts,tsx}");
  const ts = new Bun.Transpiler({ loader: "ts" });
  const tsx = new Bun.Transpiler({ loader: "tsx" });
  for (const root of DRAG_RUNTIME_SOURCE_ROOTS) {
    for (const file of sourceFiles.scanSync({ cwd: root })) {
      if (/\.(?:test|spec)\.tsx?$/u.test(file)) {
        continue;
      }
      const source = readFileSync(path.join(root, file), "utf-8");
      if (!source.includes(PRAGMATIC_IMPORT_PREFIX)) {
        continue;
      }
      const transpiler = file.endsWith(".tsx") ? tsx : ts;
      for (const entry of transpiler.scanImports(source)) {
        if (entry.path.startsWith(PRAGMATIC_IMPORT_PREFIX)) {
          imports.add(entry.path);
        }
      }
    }
  }
  return [...imports].toSorted();
};
const I18N_STORE_PATH = path.resolve(
  import.meta.dirname,
  "src/i18n/i18n-store.ts",
);
// Runtime catalog modules only; the `locales` entry is a type-only import.
const FOLIO_CATALOG_IMPORT =
  /"(@stll\/folio-react\/messages\/(?!locales")[^"]+)"/gu;

describe("vite config", () => {
  test("keeps opaque effect wrappers out of React compilation", () => {
    const isExcluded = (filePath: string) =>
      REACT_PLUGIN_EXCLUDE.some((pattern) => pattern.test(filePath));

    expect(isExcluded("/repo/apps/web/src/hooks/use-effect.ts")).toBe(true);
    expect(isExcluded("/repo/node_modules/example/index.tsx")).toBe(true);
    expect(isExcluded("/repo/apps/web/src/routes/index.tsx")).toBe(false);
  });

  test("matches the deployed browser API prefix contract", () => {
    expect(rewriteBrowserApiPath("/api/v1/me")).toBe("/v1/me");
    expect(rewriteBrowserApiPath("/api/health")).toBe("/health");
    expect(rewriteBrowserApiPath("/api/auth/get-session")).toBe(
      "/api/auth/get-session",
    );
  });

  test("includes the expected plugins", async () => {
    const resolvedConfig = resolveConfig("test");
    const plugins = await collectNamedPlugins(resolvedConfig.plugins ?? []);

    expect(plugins.length).toBeGreaterThan(0);

    const pluginNames = plugins.map((plugin) => plugin.name);
    expect(pluginNames).toContain("vite:react-babel");
    expect(pluginNames).toContain("vite:react-compiler");
    expect(pluginNames).toContain("stella-dev-route-build-guard");
    expect(pluginNames).not.toContain("@rolldown/plugin-babel");
  });

  test("forwards React Compiler warnings through the bounded logger", () => {
    const logger = createLogger("silent");
    const warn = mock(() => {});
    logger.warn = warn;

    capViteLogger(logger);
    logger.warn("[plugin vite:react-compiler] skipped component");

    expect(warn).toHaveBeenCalledWith(
      "[plugin vite:react-compiler] skipped component",
      undefined,
    );
  });

  test("proxies every public API surface through one dev origin when requested", () => {
    const previousTarget = process.env["DEV_API_PROXY_TARGET"];
    process.env["DEV_API_PROXY_TARGET"] = "http://localhost:3001";

    try {
      const resolvedConfig = resolveConfig("test");

      expect(resolvedConfig.server?.proxy).toEqual({
        "/.well-known": {
          changeOrigin: true,
          target: "http://localhost:3001",
        },
        "/api": {
          changeOrigin: true,
          target: "http://localhost:3001",
          rewrite: expect.any(Function),
        },
        "/dev-public": {
          changeOrigin: true,
          target: "http://localhost:3001",
        },
        "/health": {
          changeOrigin: true,
          target: "http://localhost:3001",
        },
        "/mcp": {
          changeOrigin: true,
          target: "http://localhost:3001",
        },
        "/oauth-ui": {
          changeOrigin: true,
          target: "http://localhost:3001",
        },
        "/v1": {
          changeOrigin: true,
          target: "http://localhost:3001",
        },
      });
    } finally {
      if (previousTarget === undefined) {
        delete process.env["DEV_API_PROXY_TARGET"];
      } else {
        process.env["DEV_API_PROXY_TARGET"] = previousTarget;
      }
    }
  });

  test("does not install a dev API proxy without an explicit target", () => {
    const previousTarget = process.env["DEV_API_PROXY_TARGET"];
    delete process.env["DEV_API_PROXY_TARGET"];

    try {
      expect(resolveConfig("test").server?.proxy).toBeUndefined();
    } finally {
      if (previousTarget !== undefined) {
        process.env["DEV_API_PROXY_TARGET"] = previousTarget;
      }
    }
  });

  test("serves Silurus WASM outside the dependency optimizer", () => {
    expect(resolveConfig("test").optimizeDeps?.exclude).toContain(
      "@silurus/ooxml",
    );
  });

  test("serves the PDF.js worker outside the dependency optimizer", () => {
    expect(resolveConfig("test").optimizeDeps?.exclude).toContain(
      "pdfjs-dist/build/pdf.worker.mjs",
    );
  });

  test("prebundles exactly the drag runtime imports without duplicate entries", () => {
    const included = resolveConfig("test").optimizeDeps?.include ?? [];
    expect(included).not.toHaveLength(0);
    expect(included.length).toBe(new Set(included).size);
    const runtimeImports = runtimeDragImports();
    expect(runtimeImports).not.toHaveLength(0);
    expect(
      included
        .filter((entry) => entry.startsWith(PRAGMATIC_IMPORT_PREFIX))
        .toSorted(),
    ).toEqual(runtimeImports);
  });

  test("every prebundled drag entry resolves from the web app", () => {
    const entries = (resolveConfig("test").optimizeDeps?.include ?? []).filter(
      (entry) => entry.startsWith(PRAGMATIC_IMPORT_PREFIX),
    );
    expect(entries).not.toHaveLength(0);
    for (const entry of entries) {
      expect(Bun.resolveSync(entry, import.meta.dirname)).toBeString();
    }
  });

  test("the drag resolver rejects a nonexistent entry", () => {
    expect(
      Bun.resolveSync(
        "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter",
        import.meta.dirname,
      ),
    ).toBeString();
    const bogus = "@atlaskit/pragmatic-drag-and-drop/does-not-exist";
    expect(() => Bun.resolveSync(bogus, import.meta.dirname)).toThrow(
      "Cannot find package '@atlaskit/pragmatic-drag-and-drop'",
    );
  });

  test("the runtime import scan excludes type-only drag entries", () => {
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(`
      import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/types";
      import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
      export { combine };
      export type { Edge };
    `);
    expect(imports.map((entry) => entry.path)).toEqual([
      "@atlaskit/pragmatic-drag-and-drop/utils/combine",
    ]);
  });

  test("prebundles every folio locale catalog the i18n store loads", () => {
    const storeSource = readFileSync(I18N_STORE_PATH, "utf-8");
    const catalogImports = Array.from(
      storeSource.matchAll(FOLIO_CATALOG_IMPORT),
      (match) => match[1],
    );

    expect(catalogImports).toContain("@stll/folio-react/messages/cs");
    expect(resolveConfig("test").optimizeDeps?.include).toEqual(
      expect.arrayContaining(catalogImports),
    );
  });

  test("applies runtime asset contracts to worker sub-builds", async () => {
    const workerPlugins = resolveConfig("test").worker?.plugins?.() ?? [];
    const pluginNames = (await collectNamedPlugins(workerPlugins)).map(
      (plugin) => plugin.name,
    );

    expect(pluginNames).toContain("stll-anonymize-wasm");
    expect(pluginNames).toContain("stella-pdfjs-worker-module-contract");
  });
});

const resolveConfig = (mode: string): UserConfig => {
  if (typeof config !== "function") {
    return config;
  }

  const env = {
    command: "build",
    isPreview: false,
    isSsrBuild: false,
    mode,
  } satisfies ConfigEnv;

  return config(env);
};

const collectNamedPlugins = async (
  options: readonly unknown[],
): Promise<{ name: string }[]> => {
  const plugins: { name: string }[] = [];

  for (const option of options) {
    if (option === false || option === null || option === undefined) {
      continue;
    }

    const resolved = await resolvePluginOption(option);

    if (Array.isArray(resolved)) {
      plugins.push(...(await collectNamedPlugins(resolved)));
      continue;
    }

    if (!hasName(resolved)) {
      continue;
    }

    plugins.push(resolved);
  }

  return plugins;
};

const resolvePluginOption = async (option: unknown): Promise<unknown> => {
  if (isPromiseLike(option)) {
    return await option;
  }
  return option;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }

  if (!("then" in value)) {
    return false;
  }

  return typeof value.then === "function";
};

const hasName = (value: unknown): value is { name: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("name" in value)) {
    return false;
  }

  return typeof value.name === "string";
};

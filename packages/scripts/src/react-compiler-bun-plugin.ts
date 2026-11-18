import { panic } from "better-result";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { transformSync as TransformSync } from "oxc-transform-react";

import { createSha256 } from "@stll/sha256/bun";

import {
  REACT_COMPILER_EXCLUDE,
  REACT_COMPILER_OPTIONS,
} from "./react-compiler-options";

/** JavaScript and TypeScript modules outside `node_modules`. */
const SOURCE_FILES = /^(?!.*[/\\]node_modules[/\\]).*\.[jt]sx?$/u;

/**
 * Test files never ship, so they load as written. Their components close over
 * the enclosing test's locals, and the compiler outlines such closures to
 * module scope, where those locals are not defined.
 */
const TEST_FILES = /\.test\.[jt]sx?$/u;

const LOADERS = {
  js: "js",
  jsx: "jsx",
  ts: "ts",
  tsx: "tsx",
} as const satisfies Record<string, Bun.Loader>;

const isLoaderExtension = (
  extension: string,
): extension is keyof typeof LOADERS => Object.hasOwn(LOADERS, extension);

const loaderOf = (filename: string): Bun.Loader => {
  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  return isLoaderExtension(extension)
    ? LOADERS[extension]
    : panic(`No loader for ${filename}`);
};

const require = createRequire(import.meta.url);

// Compiled modules are cached on disk by content. An isolated test run
// reloads the module graph for every test file, and every realm that loads
// the compiler's native binding stays resident for the rest of the run, so
// the binding loads only on a cache miss.
const COMPILER_MANIFEST: unknown = JSON.parse(
  readFileSync(require.resolve("oxc-transform-react/package.json"), "utf-8"),
);
const COMPILER_VERSION =
  typeof COMPILER_MANIFEST === "object" &&
  COMPILER_MANIFEST !== null &&
  "version" in COMPILER_MANIFEST &&
  typeof COMPILER_MANIFEST.version === "string"
    ? COMPILER_MANIFEST.version
    : panic("oxc-transform-react has no version");
const CACHE_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../../node_modules/.cache/react-compiler-bun-plugin",
);

const cacheKey = (filename: string, source: string) =>
  createSha256()
    .update(
      JSON.stringify([COMPILER_VERSION, REACT_COMPILER_OPTIONS, filename]),
    )
    .update("\0")
    .update(source)
    .digest("hex");

const cachePath = (filename: string, source: string) =>
  path.join(CACHE_DIRECTORY, `${cacheKey(filename, source)}.js`);

const compileInto = (cached: string, filename: string, source: string) => {
  const {
    transformSync,
  }: { transformSync: typeof TransformSync } = require("oxc-transform-react");
  const result = transformSync(filename, source, {
    reactCompiler: REACT_COMPILER_OPTIONS,
  });
  if (result.fatal) {
    panic(
      `React Compiler failed for ${filename}: ${result.errors.map(({ message }) => message).join("\n")}`,
    );
  }
  // Concurrent test processes may compile the same module; each writes a
  // private file and renames it into place, so a reader never sees a part.
  mkdirSync(CACHE_DIRECTORY, { recursive: true });
  const partial = `${cached}.${randomUUID()}`;
  writeFileSync(partial, result.code);
  renameSync(partial, cached);
  return result.code;
};

const compile = (filename: string, source: string): string => {
  const cached = cachePath(filename, source);
  return existsSync(cached)
    ? readFileSync(cached, "utf-8")
    : compileInto(cached, filename, source);
};

const isCompiled = (filename: string) =>
  !TEST_FILES.test(filename) &&
  !REACT_COMPILER_EXCLUDE.some((pattern) => pattern.test(filename));

/**
 * Compiles source files into the cache ahead of an isolated test run, so its
 * test files read compiled modules without loading the compiler. Takes
 * absolute paths, as Bun reports them to the plugin.
 */
export const warmReactCompilerCache = (filenames: readonly string[]) => {
  for (const filename of filenames) {
    if (SOURCE_FILES.test(filename) && isCompiled(filename)) {
      compile(filename, readFileSync(filename, "utf-8"));
    }
  }
};

/**
 * Compiles what Bun loads with the React Compiler, as the web app's Vite
 * build does. Vite's adapter is specific to Vite hooks; Bun uses the same Oxc
 * transform, so a Bun build or a test that measures rendering runs the
 * program that ships.
 */
export const reactCompilerBunPlugin = {
  name: "react-compiler",
  setup(builder: Bun.PluginBuilder) {
    // A runtime plugin (`Bun.plugin`) must return every module its filter
    // matches, and a dependency returned as source loses Bun's CommonJS
    // interop, so the filter itself leaves dependencies to Bun.
    builder.onLoad({ filter: SOURCE_FILES }, async ({ path: filename }) => {
      const source = await Bun.file(filename).text();
      if (!isCompiled(filename)) {
        return { contents: source, loader: loaderOf(filename) };
      }
      const cached = Bun.file(cachePath(filename, source));
      const code = (await cached.exists())
        ? await cached.text()
        : compileInto(
            cached.name ?? panic("cache file has no path"),
            filename,
            source,
          );
      return { contents: code, loader: "js" };
    });
  },
} satisfies Bun.BunPlugin;

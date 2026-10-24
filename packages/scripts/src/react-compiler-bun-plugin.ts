import { panic } from "better-result";
import { transform } from "oxc-transform-react";

import {
  REACT_COMPILER_EXCLUDE,
  REACT_COMPILER_OPTIONS,
} from "./react-compiler-options";

/** JavaScript and TypeScript modules outside `node_modules`. */
const SOURCE_FILES = /^(?!.*[/\\]node_modules[/\\]).*\.[jt]sx?$/u;

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
      if (REACT_COMPILER_EXCLUDE.some((pattern) => pattern.test(filename))) {
        return { contents: source, loader: loaderOf(filename) };
      }
      const result = await transform(filename, source, {
        reactCompiler: REACT_COMPILER_OPTIONS,
      });
      if (result.fatal) {
        panic(
          `React Compiler failed for ${filename}: ${result.errors.map(({ message }) => message).join("\n")}`,
        );
      }
      return { contents: result.code, loader: "js" };
    });
  },
} satisfies Bun.BunPlugin;

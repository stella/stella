/* Vite plugin that wires up @stll/anonymize-wasm so its wasm binding and
 * prepared-package assets survive both Vite's dev pre-bundler and a production
 * `vite build`.
 *
 * The package loads its wasm-bindgen binding and bundled `.stlanonpkg` packages at
 * runtime from its own `native/` asset directory via
 * `new URL("./native/…", import.meta.url)` (the wasm module, its ESM glue,
 * and the packages). The paths are computed at runtime, so neither
 * Vite's optimizer nor Rollup's static `new URL(…, import.meta.url)` handling
 * can follow them on their own.
 *
 * Dev (`vite serve`): the package is added to `optimizeDeps.exclude`, keeping
 * its original on-disk paths so the
 * relative URLs resolve next to the package's own files.
 *
 * Build (`vite build`): Rollup bundles `wasm.mjs` into a chunk, rewriting
 * `import.meta.url`, and never copies the `native/` files. This plugin emits
 * the wasm binary + glue as build assets under a stable `native/` subdir, emits
 * the selected `.stlanonpkg` prepared packages (see {@link
 * AnonymizeWasmPluginOptions.packages}), and re-anchors the package's
 * `assetUrl` base onto a Rollup file-URL reference, so the runtime URLs resolve
 * to the emitted assets from whatever chunk ends up referencing them. The
 * glue's own internal `new URL(…, import.meta.url)` reference to its `.wasm`
 * keeps working because the files are emitted side by side.
 *
 * The bundled prepared packages dominate the emitted size (the default
 * full-dictionary package alone is ~20 MB, plus per-language variants). An app
 * that only ever calls `loadPipeline` with its own package, or
 * `loadDefaultPipeline(language)` for a known subset of languages, can drop the
 * rest with the `packages` option instead of shipping every bundled package.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Plugin } from "vite";

const OPTIMIZE_EXCLUDE = ["@stll/anonymize-wasm"];
const NATIVE_DIR = "native";
/** The generated glue is always shipped in `native/`; any file there works as the
 * anchor. `new URL(fileName, <anchor>)` resolves to `native/<fileName>` because
 * URL resolution replaces the anchor's last path segment. */
const ANCHOR_FILE = "index.js";
/** The exact `assetUrl` base expression emitted by the build (see wasm.ts).
 * Kept in sync with the compiled `wasm.mjs`; the transform fails loudly if the
 * dist shape drifts so this cannot silently ship broken asset paths. */
const ASSET_URL_BASE = "`./${NATIVE_ASSET_DIR}/${fileName}`, import.meta.url";

/** Prepared packages are named `native-pipeline.stlanonpkg` (the full-dictionary
 * default) and `native-pipeline.<language>.stlanonpkg` (scoped variants). */
const PACKAGE_SUFFIX = ".stlanonpkg";
const PACKAGE_PREFIX = "native-pipeline.";
const DEFAULT_PACKAGE_FILE = `${PACKAGE_PREFIX}stlanonpkg`;
/** Selection name for the full-dictionary default package. Every other name is
 * a language code that maps to `native-pipeline.<name>.stlanonpkg`. */
const DEFAULT_PACKAGE_NAME = "default";

/** Which bundled `.stlanonpkg` prepared packages the plugin emits into a
 * production build. The wasm binary and glue are always emitted; only
 * the prepared packages are selectable because they dominate the output size.
 *
 * - `"all"` (default): every bundled package, preserving prior behavior.
 * - `"none"`: no prepared packages. The consumer must supply its own package to
 *   `loadPipeline`; `loadDefaultPipeline()` then fails at runtime with a fetch
 *   error because the asset was never emitted.
 * - a name list: only these packages. Use `"default"` for the full-dictionary
 *   package and a language code (e.g. `"cs"`, `"de"`, `"en"`) for a scoped one,
 *   for example `["cs"]` or `["default", "en"]`. A requested package that is
 *   not bundled fails the build. */
export type AnonymizeWasmPackages = "all" | "none" | readonly string[];

export type AnonymizeWasmPluginOptions = {
  packages?: AnonymizeWasmPackages;
};

const isWasmEntry = (id: string): boolean =>
  id.includes("anonymize-wasm") && basename(id) === "wasm.mjs";

const isPackageFile = (file: string): boolean => file.endsWith(PACKAGE_SUFFIX);

/** Map a selection name to its on-disk package file name. */
const packageFileName = (name: string): string =>
  name === DEFAULT_PACKAGE_NAME
    ? DEFAULT_PACKAGE_FILE
    : `${PACKAGE_PREFIX}${name}${PACKAGE_SUFFIX}`;

type PackageSelection =
  | { status: "ok"; emit: ReadonlySet<string> }
  | { status: "missing"; names: string[]; available: string[] }
  | { status: "invalid"; value: string };

/** Resolve which prepared-package files to emit for the given selection,
 * validating that every explicitly requested name exists in `nativeFiles`. */
const resolvePackageSelection = (
  nativeFiles: readonly string[],
  packages: AnonymizeWasmPackages,
): PackageSelection => {
  const packageFiles = nativeFiles.filter(isPackageFile);
  if (packages === "all") {
    return { status: "ok", emit: new Set(packageFiles) };
  }
  if (packages === "none") {
    return { status: "ok", emit: new Set() };
  }
  if (!Array.isArray(packages)) {
    // A bare string like "cs" would otherwise iterate per character below.
    return { status: "invalid", value: String(packages) };
  }
  const available = new Set(packageFiles);
  const emit = new Set<string>();
  const missing: string[] = [];
  for (const name of packages) {
    const fileName = packageFileName(name);
    if (available.has(fileName)) {
      emit.add(fileName);
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return { status: "missing", names: missing, available: packageFiles };
  }
  return { status: "ok", emit };
};

export default function stllAnonymizeWasmVite(
  options: AnonymizeWasmPluginOptions = {},
): Plugin {
  const packages = options.packages ?? "all";
  let isBuild = false;
  return {
    name: "stll-anonymize-wasm",
    // optimizeDeps only affects dev; harmless (ignored) during build.
    config() {
      return { optimizeDeps: { exclude: OPTIMIZE_EXCLUDE } };
    },
    configResolved(resolved) {
      isBuild = resolved.command === "build";
    },
    async transform(code, id) {
      if (!(isBuild && isWasmEntry(id))) {
        return null;
      }
      if (!code.includes(ASSET_URL_BASE)) {
        this.error(
          `stll-anonymize-wasm: could not find the assetUrl base in ${id}. ` +
            "The @stll/anonymize-wasm dist shape changed; update ASSET_URL_BASE " +
            "in the Vite plugin.",
        );
      }
      const nativeDir = join(dirname(id), NATIVE_DIR);
      const files = await readdir(nativeDir);
      const selection = resolvePackageSelection(files, packages);
      if (selection.status === "invalid") {
        this.error(
          `stll-anonymize-wasm: invalid packages option ${JSON.stringify(selection.value)}; ` +
            `expected "all", "none", or an array like ["default", "cs"].`,
        );
      }
      if (selection.status === "missing") {
        this.error(
          `stll-anonymize-wasm: requested package(s) not bundled: ` +
            `${selection.names.join(", ")}. Available: ${
              selection.available.join(", ") || "(none)"
            }.`,
        );
      }
      let anchorRef: string | undefined;
      for (const file of files) {
        if (isPackageFile(file) && !selection.emit.has(file)) {
          continue;
        }
        const referenceId = this.emitFile({
          type: "asset",
          fileName: `${NATIVE_DIR}/${file}`,
          source: await readFile(join(nativeDir, file)),
        });
        if (file === ANCHOR_FILE) {
          anchorRef = referenceId;
        }
      }
      if (anchorRef === undefined) {
        this.error(
          `stll-anonymize-wasm: ${ANCHOR_FILE} is missing from ${nativeDir}; ` +
            "cannot anchor the native asset base.",
        );
      }
      return {
        code: code.replace(
          ASSET_URL_BASE,
          `fileName, import.meta.ROLLUP_FILE_URL_${anchorRef}`,
        ),
        map: null,
      };
    },
  };
}

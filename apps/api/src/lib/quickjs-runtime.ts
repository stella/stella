import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
  RELEASE_ASYNC,
} from "quickjs-emscripten";

import wasmLocation from "#quickjs-release-asyncify.wasm" with { type: "file" };

const EMBEDDED_RELEASE_ASYNC = newVariant(RELEASE_ASYNC, { wasmLocation });

let modulePromise: ReturnType<
  typeof newQuickJSAsyncWASMModuleFromVariant
> | null = null;

const getModule = async () => {
  modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(
    EMBEDDED_RELEASE_ASYNC,
  );
  return await modulePromise;
};

/**
 * Create an isolated QuickJS context using an explicitly imported WASM asset.
 * Bun embeds the file into standalone executables; ordinary Bun runs resolve
 * the same package export from disk. The dependency's `newVariant` hook owns
 * the locator contract, so callers never infer its installed package layout.
 */
export const newQuickJsAsyncContext = async () =>
  (await getModule()).newContext();

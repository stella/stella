import type { NativeAnonymizeBinding } from "./native";
import {
  assertNativeBindingVersion,
  loadNativeAnonymizeBinding,
  setNativeBindingOverride,
  type LoadNativeBindingOptions,
} from "./native-node";

/**
 * Runtime-aware selection of the native binding.
 *
 * Node uses the fast NAPI addon (`stella_anonymize_napi.node`). Bun cannot run
 * it: the addon calls libuv functions Bun's NAPI shim does not implement
 * (`uv_get_osfhandle`), which aborts the process. The `@stll/anonymize-wasm`
 * binding exposes the identical `NativeAnonymizeBinding` surface and runs
 * cleanly under both runtimes.
 *
 * The wasm binding loads asynchronously, but most consumers (the docx and pdf
 * packages, `getDefaultNativePipeline`) call `loadNativeAnonymizeBinding()`
 * synchronously. So under Bun an entry point calls `preloadNativeBinding()`
 * once (async) at startup; it installs the wasm binding as the loader override,
 * after which every synchronous `loadNativeAnonymizeBinding()` returns it. On
 * Node this is a no-op and the NAPI path is unchanged.
 */
export const isBunRuntime = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let wasmBindingPromise: Promise<NativeAnonymizeBinding> | undefined;

const loadWasmBinding = async (): Promise<NativeAnonymizeBinding> => {
  // Dynamic so Node never pulls the wasm binding into its module graph, and so
  // the specifier is only resolved on the runtime that needs it.
  const wasm = await import("@stll/anonymize-wasm");
  return wasm.getBinding();
};

/**
 * Resolve the default native binding for the current runtime: the NAPI addon on
 * Node, the wasm binding on Bun (loaded and cached once).
 */
export const loadDefaultNativeBinding = async (
  options: LoadNativeBindingOptions = {},
): Promise<NativeAnonymizeBinding> => {
  if (!isBunRuntime()) {
    return loadNativeAnonymizeBinding(options);
  }
  wasmBindingPromise ??= loadWasmBinding();
  const binding = await wasmBindingPromise;
  if (options.expectedVersion !== undefined) {
    assertNativeBindingVersion({
      binding,
      expectedVersion: options.expectedVersion,
    });
  }
  return binding;
};

let preloadPromise: Promise<void> | undefined;

/**
 * Under Bun, load the wasm binding once and install it as the synchronous
 * loader override so every `loadNativeAnonymizeBinding()` caller uses it. A
 * no-op on Node. Idempotent and safe to await from every entry point.
 */
export const preloadNativeBinding = async (): Promise<void> => {
  if (!isBunRuntime()) {
    return;
  }
  preloadPromise ??= (async () => {
    setNativeBindingOverride(await loadDefaultNativeBinding());
  })();
  return preloadPromise;
};

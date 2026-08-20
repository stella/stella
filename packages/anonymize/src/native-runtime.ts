import type { NativeAnonymizeBinding } from "./native";
import {
  loadNativeAnonymizeBinding,
  type LoadNativeBindingOptions,
} from "./native-node";

/**
 * Report whether the current JavaScript runtime is Bun.
 */
export const isBunRuntime = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Resolve the N-API binding used by both Node.js and Bun.
 */
export const loadDefaultNativeBinding = async (
  options: LoadNativeBindingOptions = {},
): Promise<NativeAnonymizeBinding> => loadNativeAnonymizeBinding(options);

let preloadPromise: Promise<void> | undefined;

/**
 * Eagerly validate the native binding. Retained for compatibility with callers
 * that preloaded the former Bun-specific runtime fallback.
 */
export const preloadNativeBinding = async (): Promise<void> => {
  preloadPromise ??= Promise.resolve().then(() => {
    loadNativeAnonymizeBinding();
    return undefined;
  });
  return preloadPromise;
};

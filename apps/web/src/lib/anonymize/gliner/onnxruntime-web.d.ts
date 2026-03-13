/**
 * Ambient module declarations for onnxruntime-web.
 *
 * The package ships types at `types.d.ts` but the
 * package.json `exports` field doesn't include a `types`
 * entry, so TypeScript cannot resolve them. This file
 * re-exports the underlying `onnxruntime-common` types.
 */

declare module "onnxruntime-web" {
  export * from "onnxruntime-common";
}

declare module "onnxruntime-web/webgpu" {
  export * from "onnxruntime-common";
}

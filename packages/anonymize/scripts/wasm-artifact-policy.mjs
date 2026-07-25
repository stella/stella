/**
 * Browser WebAssembly artifacts and their uncompressed release ceilings.
 *
 * Keep this policy shared by assembly and tarball validation so a generated
 * runtime cannot bypass the size gate after it has been copied into dist/.
 */
export const WASM_RUNTIME_ARTIFACTS = Object.freeze([
  Object.freeze({
    source: "index.js",
    packagePath: "dist/native/index.js",
    maxBytes: 128 * 1024,
  }),
  Object.freeze({
    source: "index_bg.wasm",
    packagePath: "dist/native/index_bg.wasm",
    maxBytes: 8 * 1024 * 1024,
  }),
]);

export const assertWasmArtifactSize = ({ file, bytes, maxBytes }) => {
  if (bytes > maxBytes) {
    throw new Error(
      `${file} is ${bytes} bytes; browser runtime ceiling is ${maxBytes} bytes`,
    );
  }
};

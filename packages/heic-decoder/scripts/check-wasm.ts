import path from "node:path";

import { checkGeneratedWasm } from "../../../scripts/generated-wasm-drift";

// Compares a fresh build (scripts/build-wasm.sh with HEIC_DECODER_WASM_OUT_DIR)
// against the committed bindings.
checkGeneratedWasm({
  packageDir: path.join(import.meta.dir, ".."),
  outDirEnv: "HEIC_DECODER_WASM_OUT_DIR",
});

import { panic } from "better-result";
import { readFileSync } from "node:fs";

const native = readFileSync(
  new URL("../src-tauri/src/types.rs", import.meta.url),
  "utf-8",
);
const revision = /^pub const BRIDGE_VERSION: u32 = (\d+);$/mu
  .exec(native)
  ?.at(1);
if (!revision) {
  panic(
    "Cannot read BRIDGE_VERSION from apps/desktop/src-tauri/src/types.rs; expected `pub const BRIDGE_VERSION: u32 = N;`",
  );
}

export const BRIDGE_VERSION = Number(revision);

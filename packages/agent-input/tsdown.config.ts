import { defineConfig } from "tsdown";

import packageManifest from "./package.json" with { type: "json" };

const entry = Object.values(packageManifest.exports).map((target) =>
  target.replace(/^\.\//u, ""),
);

export default defineConfig({
  entry,
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});

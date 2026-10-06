import { panic } from "better-result";
import path from "node:path";

import { escapeVisualScript } from "../src/handlers/visual-sandbox/srcdoc";
import { VISUAL_RUNTIME_BUILD_OPTIONS } from "./visual-sandbox-build-options";

const root = path.resolve(
  import.meta.dirname,
  "../src/handlers/visual-sandbox",
);
const result = await Bun.build({
  entrypoints: [path.join(root, "browser/runtime.ts")],
  ...VISUAL_RUNTIME_BUILD_OPTIONS,
});
if (!result.success) {
  panic(result.logs.map(({ message }) => message).join("\n"));
}
const output = result.outputs.at(0);
if (result.outputs.length !== 1 || !output) {
  panic("Visual runtime requires one output");
}
const source = escapeVisualScript((await output.text()).trim());
if (/<\/script/iu.test(source)) {
  panic("Visual runtime requires HTML-safe script text");
}
await Bun.write(path.join(root, "generated/runtime.js.txt"), source);

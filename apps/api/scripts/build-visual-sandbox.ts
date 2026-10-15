import { panic } from "better-result";
import path from "node:path";

import { VISUAL_PRESENTATION_CSS } from "../src/handlers/visual-sandbox/browser/presentation-css";
import { escapeVisualScript } from "../src/handlers/visual-sandbox/srcdoc";
import {
  VISUAL_RUNTIME_BUILD_OPTIONS,
  VISUAL_RUNTIME_BYTE_BUDGET,
} from "./visual-sandbox-build-options";
import { buildVisualFontFaces } from "./visual-sandbox-fonts";

const root = path.resolve(
  import.meta.dirname,
  "../src/handlers/visual-sandbox",
);
const result = await Bun.build({
  entrypoints: [path.join(root, "browser/runtime.ts")],
  ...VISUAL_RUNTIME_BUILD_OPTIONS,
  define: {
    STELLA_VISUAL_FONT_FACES: JSON.stringify(
      await buildVisualFontFaces(VISUAL_PRESENTATION_CSS),
    ),
  },
});
if (!result.success) {
  panic(result.logs.map(({ message }) => message).join("\n"));
}
const output = result.outputs.at(0);
if (result.outputs.length !== 1 || !output) {
  panic("Visual runtime requires one output");
}
const source = escapeVisualScript((await output.text()).trim());
const sourceBytes = new TextEncoder().encode(source).byteLength;
if (sourceBytes > VISUAL_RUNTIME_BYTE_BUDGET) {
  panic(
    `Visual runtime is ${sourceBytes} bytes; budget is ${VISUAL_RUNTIME_BYTE_BUDGET} bytes`,
  );
}
if (/<\/script/iu.test(source)) {
  panic("Visual runtime requires HTML-safe script text");
}
await Bun.write(path.join(root, "generated/runtime.js.txt"), source);

import { build } from "bun";

const result = await build({
  entrypoints: [new URL("render-probe-browser.ts", import.meta.url).pathname],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!result.success) {
  throw new AggregateError(result.logs, "Could not bundle the render probe");
}
const output = result.outputs.at(0);
if (output === undefined) {
  throw new Error("The render probe build produced no JavaScript");
}
process.stdout.write(await output.text());

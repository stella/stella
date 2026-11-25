import { panic, TaggedError } from "better-result";
import { build } from "bun";
import { fileURLToPath } from "node:url";

class RenderProbeBundleError extends TaggedError("RenderProbeBundleError")<{
  message: string;
  cause: unknown;
}> {}

// Bundles one of the scripts e2e helpers inject into a page before the app
// loads: the render probe (default) or the storm watch.
const ENTRIES = {
  "render-probe": "../e2e/helpers/render-probe-browser.ts",
  "storm-watch": "../e2e/helpers/storm-watch-browser.ts",
} as const;
const isEntry = (name: string): name is keyof typeof ENTRIES =>
  Object.hasOwn(ENTRIES, name);
const requested = process.argv[2] ?? "render-probe";
if (!isEntry(requested)) {
  panic(`Unknown injected script "${requested}"`);
}
const entry = ENTRIES[requested];

const result = await build({
  entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!result.success) {
  throw new RenderProbeBundleError({
    message: "Could not bundle the render probe",
    cause: result.logs,
  });
}
const output = result.outputs.at(0);
if (output === undefined) {
  panic("The render probe build produced no JavaScript");
}
process.stdout.write(await output.text());

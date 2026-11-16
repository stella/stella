import { panic, TaggedError } from "better-result";
import { build } from "bun";

class RenderProbeBundleError extends TaggedError("RenderProbeBundleError")<{
  message: string;
  cause: unknown;
}> {}

const result = await build({
  entrypoints: [
    new URL("../e2e/helpers/render-probe-browser.ts", import.meta.url).pathname,
  ],
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

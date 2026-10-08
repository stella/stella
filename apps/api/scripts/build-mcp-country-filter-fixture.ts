import { panic } from "better-result";
import path from "node:path";

import { parseCaseLawLaunchReadiness } from "@stll/api-contract/case-law-launch-readiness";
import {
  ADMITTED_PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
} from "@stll/api-contract/public-country-capability";

const countries = [
  ...new Set([...ADMITTED_PUBLIC_COUNTRIES, "SVK"]),
].toSorted();
const readiness = countries.map((country) => ({
  country,
  evalSetExists: true,
  lastCensusDate: "2026-01-01",
  lastCensusGreen: true,
}));
parseCaseLawLaunchReadiness(readiness);

// Seed admission data only in this browser fixture; compile the real app unchanged.
const result = await Bun.build({
  entrypoints: [
    path.resolve(
      import.meta.dirname,
      "../src/mcp/apps/case-law-results/app.html",
    ),
  ],
  // As in build-mcp-apps.ts: an HTML entry with `compile` and a browser
  // target yields one self-contained document with scripts inlined.
  compile: true,
  target: "browser",
  minify: true,
  plugins: [
    {
      name: "fixture-country-admission",
      setup(build) {
        build.onLoad({ filter: /\/launch-readiness\.json$/u }, () => ({
          contents: JSON.stringify(readiness),
          loader: "json",
        }));
        build.onLoad(
          { filter: /\/public-country-capability\.ts$/u },
          async ({ path: file }) => {
            const source = await Bun.file(file).text();
            const declaration = `SVK: "${PUBLIC_COUNTRY_CAPABILITIES.SVK}"`;
            if (source.split(declaration).length !== 2) {
              panic("Country fixture requires one SVK admission declaration");
            }
            return {
              contents: source.replace(declaration, 'SVK: "admitted"'),
              loader: "ts",
            };
          },
        );
      },
    },
  ],
});
const output = result.outputs.at(0);
if (
  !result.success ||
  result.outputs.length !== 1 ||
  output?.kind !== "entry-point"
) {
  panic("Country fixture requires one compiled browser document", result.logs);
}
process.stdout.write(await output.text());

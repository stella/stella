import { panic } from "better-result";
import path from "node:path";

import {
  CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES,
  parseCaseLawLaunchReadiness,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  PUBLIC_COUNTRY_CAPABILITIES,
  publicCountriesFor,
} from "@stll/api-contract/public-country-capability";

// An explicitly launched country carries no serving receipt: the app refuses
// a country that has both.
const countries = [
  ...new Set([...publicCountriesFor("caseLaw", "search"), "SVK"]),
]
  .filter(
    (country) =>
      !CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES.some((launch) => launch === country),
  )
  .toSorted();
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
      "../../../packages/mcp-apps/src/case-law-results/app.html",
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
            const declaration = `SVK: { caseLaw: "${PUBLIC_COUNTRY_CAPABILITIES.SVK.caseLaw}"`;
            if (source.split(declaration).length !== 2) {
              panic("Country fixture requires one SVK admission declaration");
            }
            return {
              contents: source.replace(
                declaration,
                'SVK: { caseLaw: "admitted"',
              ),
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

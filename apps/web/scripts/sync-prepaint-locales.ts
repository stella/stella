#!/usr/bin/env bun

import path from "node:path";

import { RTL_UI_LOCALES, UI_LOCALES } from "@stll/locales";

const checkOnly = process.argv.includes("--check");
const outputPath = path.resolve(
  import.meta.dirname,
  "../public/prepaint-init.js",
);
const startMarker = "  // <generated:ui-locales>";
const endMarker = "  // </generated:ui-locales>";

const formatArray = (values: readonly string[]): string =>
  values.length === 1
    ? `[${JSON.stringify(values[0])}]`
    : `[\n${values.map((value) => `    ${JSON.stringify(value)},`).join("\n")}\n  ]`;

const generatedBlock = `${startMarker}
  // Generated from @stll/locales. Run \`bun run typegen\` after changing
  // the canonical UI locale contract.
  const UI_LOCALES = ${formatArray(UI_LOCALES)};
  const RTL_LOCALES = ${formatArray(RTL_UI_LOCALES)};
${endMarker}`;

const source = await Bun.file(outputPath).text();
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);

if (start === -1 || end < start) {
  console.error(`Generated locale markers are missing from ${outputPath}`);
  process.exit(1);
}

const nextSource = `${source.slice(0, start)}${generatedBlock}${source.slice(end + endMarker.length)}`;

if (source === nextSource) {
  console.log(`${outputPath} locale metadata is in sync`);
} else if (checkOnly) {
  console.error(
    `${outputPath} locale metadata is stale. Run \`bun --cwd apps/web typegen\`.`,
  );
  process.exit(1);
} else {
  await Bun.write(outputPath, nextSource);
  console.log(`Updated locale metadata in ${outputPath}`);
}

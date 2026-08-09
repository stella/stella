import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PLUGIN_DIRECTORY = ".oxlint-plugins";
const FIXTURE_DIRECTORY = path.join(PLUGIN_DIRECTORY, "__fixtures__");
const CONFIG_PATH = "oxlint.config.ts";
const NON_PLUGIN_MODULES = new Set(["physical-properties.ts", "utils.ts"]);

const pluginFiles = readdirSync(PLUGIN_DIRECTORY)
  .filter((file) => file.endsWith(".ts") && !NON_PLUGIN_MODULES.has(file))
  .sort();
const fixtureNames = new Set(
  readdirSync(FIXTURE_DIRECTORY).flatMap((file) => {
    const match = /^(?<pluginName>.+)\.fixture\.[^.]+$/u.exec(file);
    return match?.groups?.["pluginName"] === undefined
      ? []
      : [match.groups["pluginName"]];
  }),
);
const config = readFileSync(CONFIG_PATH, "utf-8");
const errors: string[] = [];

for (const file of pluginFiles) {
  const pluginName = path.basename(file, ".ts");
  const source = readFileSync(path.join(PLUGIN_DIRECTORY, file), "utf-8");
  const specifier = `./${PLUGIN_DIRECTORY}/${file}`;

  if (!config.includes(JSON.stringify(specifier))) {
    errors.push(`${file}: missing from ${CONFIG_PATH} jsPlugins`);
  }
  if (!source.includes('from "@oxlint/plugins"')) {
    errors.push(`${file}: missing @oxlint/plugins import`);
  }
  if (!source.includes("eslintCompatPlugin({")) {
    errors.push(`${file}: default export is not wrapped in eslintCompatPlugin`);
  }
  if (!source.includes("createOnce(")) {
    errors.push(`${file}: no createOnce rule implementation found`);
  }
  if (/\bcreate\s*\(context/u.test(source)) {
    errors.push(`${file}: legacy per-file create(...) implementation remains`);
  }
  if (!fixtureNames.has(pluginName)) {
    errors.push(`${file}: missing module-named fixture`);
  }
}

if (errors.length > 0) {
  console.error("Oxlint plugin registry check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Oxlint plugin registry OK (${pluginFiles.length} plugins, ${fixtureNames.size} fixture modules).`,
  );
}

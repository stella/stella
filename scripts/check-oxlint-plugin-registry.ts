import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PLUGIN_DIRECTORY = ".oxlint-plugins";
const FIXTURE_DIRECTORY = path.join(PLUGIN_DIRECTORY, "__fixtures__");
const CONFIG_PATH = "oxlint.config.ts";
const README_PATH = path.join(PLUGIN_DIRECTORY, "README.md");
const NON_PLUGIN_MODULES = new Set(["physical-properties.ts", "utils.ts"]);

const pluginFiles = readdirSync(PLUGIN_DIRECTORY)
  .filter((file) => file.endsWith(".ts") && !NON_PLUGIN_MODULES.has(file))
  .sort();
const fixtureFiles = readdirSync(FIXTURE_DIRECTORY).filter((file) =>
  file.includes(".fixture."),
);
const config = readFileSync(CONFIG_PATH, "utf-8");
const productionConfig = config.slice(
  config.indexOf("export default defineConfig"),
);
const enabledRuleIds = new Set(
  Array.from(
    productionConfig.matchAll(
      /"(?<ruleId>[a-z0-9-]+\/[a-z0-9-]+)"\s*:\s*(?:"error"|\[\s*"error")/gu,
    ),
    (match) => match.groups?.["ruleId"],
  ).filter((ruleId): ruleId is string => ruleId !== undefined),
);
const readme = readFileSync(README_PATH, "utf-8");
const errors: string[] = [];
let ruleCount = 0;

const ruleNamesFromSource = (source: string): string[] => {
  const literalNames = Array.from(
    source.matchAll(/^ {4}"(?<ruleName>[a-z0-9-]+)": \{$/gmu),
    (match) => match.groups?.["ruleName"],
  ).filter((ruleName): ruleName is string => ruleName !== undefined);
  const computedRuleName = source.includes("    [RULE_NAME]: {")
    ? /const RULE_NAME = "(?<ruleName>[a-z0-9-]+)";/u.exec(source)?.groups?.[
        "ruleName"
      ]
    : undefined;
  return computedRuleName === undefined
    ? literalNames
    : [...literalNames, computedRuleName];
};

for (const file of pluginFiles) {
  const pluginName = path.basename(file, ".ts");
  const source = readFileSync(path.join(PLUGIN_DIRECTORY, file), "utf-8");
  const specifier = `./${PLUGIN_DIRECTORY}/${file}`;
  const ruleNames = ruleNamesFromSource(source);
  const fixtureSources = fixtureFiles
    .filter((fixture) => fixture.startsWith(`${pluginName}.fixture.`))
    .map((fixture) =>
      readFileSync(path.join(FIXTURE_DIRECTORY, fixture), "utf-8"),
    );

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

  const literalMetaName = /meta: \{ name: "(?<name>[a-z0-9-]+)" \}/u.exec(
    source,
  )?.groups?.["name"];
  const usesMatchingRuleNameConstant =
    source.includes("meta: { name: RULE_NAME }") &&
    source.includes(`const RULE_NAME = "${pluginName}";`);
  if (literalMetaName !== pluginName && !usesMatchingRuleNameConstant) {
    errors.push(`${file}: plugin meta.name must match its filename`);
  }
  if (ruleNames.length === 0) {
    errors.push(`${file}: no exported rule IDs could be derived`);
  }
  if (fixtureSources.length === 0) {
    errors.push(`${file}: missing module-named fixture`);
  }
  const readmeLink = `](./${file})`;
  const readmeLinkCount = readme.split(readmeLink).length - 1;
  if (readmeLinkCount !== 1) {
    errors.push(
      `${file}: expected one linked catalogue entry in ${README_PATH}, found ${readmeLinkCount}`,
    );
  }

  for (const ruleName of ruleNames) {
    ruleCount += 1;
    const fullRuleId = `${pluginName}/${ruleName}`;
    if (!enabledRuleIds.has(fullRuleId)) {
      errors.push(`${file}: ${fullRuleId} is not enabled in production config`);
    }
    if (!fixtureSources.some((fixture) => fixture.includes(fullRuleId))) {
      errors.push(`${file}: fixture does not target ${fullRuleId}`);
    }
    if (!readme.includes(`\`${ruleName}\``)) {
      errors.push(`${file}: README does not name rule \`${ruleName}\``);
    }
  }
}

for (const match of readme.matchAll(/\]\(\.\/(?<file>[a-z0-9-]+\.ts)\)/gu)) {
  const file = match.groups?.["file"];
  if (file !== undefined && !existsSync(path.join(PLUGIN_DIRECTORY, file))) {
    errors.push(`${README_PATH}: broken local plugin link ./${file}`);
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
    `Oxlint plugin registry OK (${pluginFiles.length} plugins, ${ruleCount} rules, ${fixtureFiles.length} fixtures).`,
  );
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import oxlintConfig from "../oxlint.config.ts";
import { parseSource, walk } from "../packages/scripts/src/syntax-tree";
import { readScopes } from "./oxlint-config-scopes.ts";
import { severityOf } from "./oxlint-effective-config.ts";

const PLUGIN_DIRECTORY = ".oxlint-plugins";
const FIXTURE_DIRECTORY = path.join(PLUGIN_DIRECTORY, "__fixtures__");
const CONFIG_PATH = "oxlint.config.ts";
const README_PATH = path.join(PLUGIN_DIRECTORY, "README.md");
export const NON_PLUGIN_MODULES: ReadonlySet<string> = new Set([
  "aggregate-lock-sites.ts",
  "budget-ledger.ts",
  "database-access.ts",
  "api-client-chain.ts",
  "icon-ownership.ts",
  "module-id.ts",
  "network-call.ts",
  "physical-properties.ts",
  "public-law-decision-surface-modules.ts",
  "public-read-io-provenance.ts",
  "restricted-import.ts",
  "utils.ts",
]);

const pluginFiles = readdirSync(PLUGIN_DIRECTORY)
  .filter((file) => file.endsWith(".ts") && !NON_PLUGIN_MODULES.has(file))
  .toSorted();
const fixtureFiles = readdirSync(FIXTURE_DIRECTORY).filter((file) =>
  file.includes(".fixture."),
);
const config = readFileSync(CONFIG_PATH, "utf-8");
const enabledRuleIds = new Set(
  readScopes(oxlintConfig).flatMap((scope) =>
    Object.entries(scope.rules)
      .filter(([, value]) => severityOf(value) === "error")
      .map(([ruleId]) => ruleId),
  ),
);
const readme = readFileSync(README_PATH, "utf-8");
const errors: string[] = [];
let ruleCount = 0;

export const ruleNamesFromSource = (source: string): string[] => {
  const tree = parseSource("plugin.ts", source).program;
  const constants = new Map<string, string>();
  for (const entry of tree.body) {
    const statement =
      entry.type === "ExportNamedDeclaration" && entry.declaration
        ? entry.declaration
        : entry;
    if (statement.type !== "VariableDeclaration") {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type === "Identifier" &&
        declaration.init?.type === "Literal" &&
        typeof declaration.init.value === "string"
      ) {
        constants.set(declaration.id.name, declaration.init.value);
      }
    }
  }
  const names = new Set<string>();
  walk(tree, (node) => {
    if (
      node.type !== "Property" ||
      node.computed ||
      node.method ||
      node.shorthand ||
      node.kind !== "init" ||
      !(
        (node.key.type === "Identifier" && node.key.name === "rules") ||
        (node.key.type === "Literal" && node.key.value === "rules")
      ) ||
      node.value.type !== "ObjectExpression"
    ) {
      return;
    }
    for (const property of node.value.properties) {
      if (
        property.type !== "Property" ||
        property.method ||
        property.shorthand ||
        property.kind !== "init"
      ) {
        continue;
      }
      const name = property.key;
      let ruleName: string | undefined;
      if (property.computed) {
        if (name.type === "Identifier") {
          ruleName = constants.get(name.name);
        }
      } else if (name.type === "Identifier") {
        ruleName = name.name;
      } else if (name.type === "Literal" && typeof name.value === "string") {
        ruleName = name.value;
      }
      if (ruleName !== undefined) {
        names.add(ruleName);
      }
    }
  });
  return [...names];
};

const DISABLE_DIRECTIVE_PREFIXES = [
  "oxlint-disable-next-line ",
  "oxlint-disable-line ",
  "oxlint-disable ",
  "eslint-disable-next-line ",
  "eslint-disable-line ",
  "eslint-disable ",
] as const;

const commentBodyFromLine = (line: string): string | undefined => {
  const trimmedLine = line.trimStart();
  if (trimmedLine.startsWith("{/*")) {
    return trimmedLine.slice(3).trimStart();
  }
  if (trimmedLine.startsWith("/*")) {
    return trimmedLine.slice(2).trimStart();
  }
  const lineCommentStart = line.lastIndexOf("//");
  if (lineCommentStart !== -1) {
    return line.slice(lineCommentStart + 2).trimStart();
  }
  return undefined;
};

const stripBlockCommentEnd = (ruleList: string): string => {
  if (ruleList.endsWith("*/}")) {
    return ruleList.slice(0, -3);
  }
  if (ruleList.endsWith("*/")) {
    return ruleList.slice(0, -2);
  }
  return ruleList;
};

const fixtureHasRuleDisable = (source: string, ruleId: string): boolean =>
  source.split("\n").some((line) => {
    const commentBody = commentBodyFromLine(line);
    if (commentBody === undefined) {
      return false;
    }
    const directivePrefix = DISABLE_DIRECTIVE_PREFIXES.find((prefix) =>
      commentBody.startsWith(prefix),
    );
    if (directivePrefix === undefined) {
      return false;
    }

    const directiveBody = commentBody.slice(directivePrefix.length);
    const rationaleStart = directiveBody.indexOf(" --");
    const ruleList = (
      rationaleStart === -1
        ? directiveBody
        : directiveBody.slice(0, rationaleStart)
    ).trimEnd();
    const rules = stripBlockCommentEnd(ruleList);

    return rules.split(",").some((rule) => rule.trim() === ruleId);
  });

// Names exported by the shared helper module. A plugin declaring one of them
// keeps a private copy that drifts from the shared behaviour.
export const sharedHelperNames = (utilsSource: string): string[] =>
  Array.from(
    utilsSource.matchAll(
      /^export (?:const|function|type) (?<name>[A-Za-z_$][\w$]*)/gmu,
    ),
    (match) => match.groups?.["name"],
  ).filter((name): name is string => name !== undefined);

export const redeclaredSharedHelpers = (
  source: string,
  helperNames: readonly string[],
): string[] =>
  helperNames.filter((name) =>
    new RegExp(
      `(?:^|[\\s;])(?:const|let|function|type)\\s+${name.replaceAll("$", "\\$")}\\s*[=<(:]`,
      "u",
    ).test(source),
  );

const helperNames = sharedHelperNames(
  readFileSync(path.join(PLUGIN_DIRECTORY, "utils.ts"), "utf-8"),
);

// A case the rule must accept, checked line by line by
// scripts/check-oxlint-fixture-counts.ts.
export const fixtureHasCleanCase = (source: string, ruleId: string): boolean =>
  source.split("\n").some((line) => {
    const marker = /(?:\/\/|\/\*)\s*expect-clean:\s*(?<rules>[^*]+)/u.exec(line)
      ?.groups?.["rules"];
    return marker?.split(",").some((rule) => rule.trim() === ruleId) === true;
  });

for (const file of pluginFiles) {
  const pluginName = path.basename(file, ".ts");
  const source = readFileSync(path.join(PLUGIN_DIRECTORY, file), "utf-8");
  for (const name of redeclaredSharedHelpers(source, helperNames)) {
    errors.push(
      `${file}: redeclares \`${name}\`; import it from ./utils.ts instead`,
    );
  }
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
    if (
      !fixtureSources.some((fixture) =>
        fixtureHasRuleDisable(fixture, fullRuleId),
      )
    ) {
      errors.push(`${file}: fixture does not disable ${fullRuleId}`);
    }
    if (
      !fixtureSources.some((fixture) =>
        fixtureHasCleanCase(fixture, fullRuleId),
      )
    ) {
      errors.push(
        `${file}: fixture has no \`expect-clean: ${fullRuleId}\` case`,
      );
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

if (import.meta.main) {
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
}

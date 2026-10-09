#!/usr/bin/env bun
// Migrates package-local localeCompare calls to the shared cached collator.
// Rerunnable after rebases; --check reports callers that still need migration.

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");
const sourceFiles = Bun.spawnSync({
  cmd: [
    "git",
    "ls-files",
    "packages/**/*.ts",
    "packages/**/*.tsx",
    "packages/**/*.js",
    "packages/**/*.jsx",
    "packages/**/*.mjs",
    "packages/**/*.cjs",
  ],
  cwd: repositoryRoot,
  stdout: "pipe",
});

if (sourceFiles.exitCode !== 0) {
  panic("Could not list package source files");
}

const changed: string[] = [];

for (const relativePath of sourceFiles.stdout.toString().trim().split("\n")) {
  if (!relativePath || relativePath.startsWith("packages/collation/")) {
    continue;
  }

  const filePath = path.join(repositoryRoot, relativePath);
  const source = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const replacements: { end: number; start: number; text: string }[] = [];
  const locales = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "localeCompare"
    ) {
      const compared = node.arguments.at(0);
      if (compared === undefined) {
        panic(`${relativePath}: localeCompare call has no comparison value`);
      }
      const localeArgument = node.arguments.at(1);
      const optionsArgument = node.arguments.at(2);
      if (optionsArgument !== undefined) {
        panic(
          `${relativePath}: collation options need a named module comparator`,
        );
      }
      const locale = localeArgument?.getText(sourceFile) ?? '"en"';
      const binding = locale === '"cs-CZ"' ? "compareCzech" : "compareEnglish";
      if (locale !== '"cs-CZ"' && locale !== '"en"') {
        panic(`${relativePath}: dynamic locale needs a named manual migration`);
      }
      locales.add(binding);
      replacements.push({
        start: node.getStart(sourceFile),
        end: node.end,
        text: `${binding}(${node.expression.expression.getText(sourceFile)}, ${compared.getText(sourceFile)})`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (replacements.length === 0) {
    continue;
  }

  let output = source;
  for (const replacement of replacements.toSorted(
    (a, b) => b.start - a.start,
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.text +
      output.slice(replacement.end);
  }

  const declarations = [
    locales.has("compareCzech")
      ? 'const compareCzech = compareByLocale("cs-CZ");'
      : null,
    locales.has("compareEnglish")
      ? 'const compareEnglish = compareByLocale("en");'
      : null,
  ].filter((line) => line !== null);
  const importLine = 'import { compareByLocale } from "@stll/collation";\n';
  const insertion = output.startsWith("#!") ? output.indexOf("\n") + 1 : 0;
  const lastImportEnd = sourceFile.statements.findLast(
    ts.isImportDeclaration,
  )?.end;
  const declarationInsertion = (lastImportEnd ?? insertion) + importLine.length;
  output = output.slice(0, insertion) + importLine + output.slice(insertion);
  output = [
    output.slice(0, declarationInsertion),
    declarations.join("\n"),
    output.slice(declarationInsertion),
  ].join("\n");

  changed.push(relativePath);
  if (!checkOnly) {
    writeFileSync(filePath, output);
  }
}

if (changed.length > 0) {
  console.log(changed.join("\n"));
  if (checkOnly) {
    process.exitCode = 1;
  }
}

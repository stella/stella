import { panic } from "better-result";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

export const REACHABILITY_CATEGORIES = [
  "imported-source-subject",
  "source-factory",
  "e2e-surface",
  "spawned-entry",
  "sql-or-schema-reader",
  "artifact-or-workflow-guard",
  "repository-text-guard",
] as const;

type ReachabilityCategory = (typeof REACHABILITY_CATEGORIES)[number];

export type ReachabilityFinding = {
  file: string;
  kind: "no-classified-reachability" | "local-export-collision";
  name?: string;
};

type AnalyzeOptions = { repoRoot: string; files?: readonly string[] };

export const parseReachabilityBaseline = (
  text: string,
): Record<string, string[]> => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return panic("test subject reachability baseline must be an object");
  }
  const entries: (readonly [string, string[]])[] = [];
  for (const [file, members] of Object.entries(parsed)) {
    if (
      !TEST_FILE.test(file) ||
      !Array.isArray(members) ||
      members.some((member) => typeof member !== "string")
    ) {
      return panic(`Invalid test subject reachability baseline entry: ${file}`);
    }
    entries.push([file, members]);
  }
  return Object.fromEntries(entries);
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_SUPPORT =
  /(?:^|\/)(?:__tests__|test|tests|fixtures?|mocks?|test-utils?)(?:\/|[.-])/u;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;

const parse = (file: string, text: string) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const trackedTests = (repoRoot: string): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(`Could not enumerate tests: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => TEST_FILE.test(file));
};

const candidatePaths = (
  repoRoot: string,
  testFile: string,
  specifier: string,
) => {
  const packageMatch = /^(apps|packages)\/([^/]+)\//u.exec(testFile);
  let unresolved: string | undefined;
  if (specifier.startsWith(".")) {
    unresolved = path.resolve(repoRoot, path.dirname(testFile), specifier);
  } else if (specifier.startsWith("@/") && packageMatch) {
    const rootKind = packageMatch.at(1);
    const packageName = packageMatch.at(2);
    if (rootKind === undefined || packageName === undefined) {
      return panic(`Invalid package path: ${testFile}`);
    }
    const aliasPath =
      packageName === "api" && specifier.startsWith("@/api/")
        ? specifier.slice("@/api/".length)
        : specifier.slice(2);
    unresolved = path.resolve(
      repoRoot,
      rootKind,
      packageName,
      "src",
      aliasPath,
    );
  } else if (specifier.startsWith("@stll/")) {
    const [packageName, ...rest] = specifier.slice("@stll/".length).split("/");
    if (packageName === undefined) {
      return [];
    }
    const rootKind = statSync(
      path.join(repoRoot, "packages", packageName, "package.json"),
      { throwIfNoEntry: false },
    )?.isFile()
      ? "packages"
      : "apps";
    unresolved = path.resolve(repoRoot, rootKind, packageName, "src", ...rest);
  }
  if (!unresolved) {
    return [];
  }
  return [
    unresolved,
    ...[".ts", ".tsx", ".mts", ".cts"].map(
      (extension) => `${unresolved}${extension}`,
    ),
    ...["index.ts", "index.tsx"].map((name) => path.join(unresolved, name)),
  ];
};

const existingSource = (
  repoRoot: string,
  testFile: string,
  specifier: string,
): string | undefined =>
  candidatePaths(repoRoot, testFile, specifier).find((candidate) => {
    const relative = path
      .relative(repoRoot, candidate)
      .replaceAll(path.sep, "/");
    return (
      SOURCE_FILE.test(candidate) &&
      !TEST_FILE.test(candidate) &&
      !TEST_SUPPORT.test(relative) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    );
  });

const namedImports = (node: ts.ImportDeclaration): string[] => {
  if (node.importClause?.isTypeOnly) {
    return [];
  }
  const names: string[] = [];
  if (node.importClause?.name) {
    names.push(node.importClause.name.text);
  }
  const bindings = node.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        names.push(element.name.text);
      }
    }
  } else if (bindings && ts.isNamespaceImport(bindings)) {
    names.push(bindings.name.text);
  }
  return names;
};

const usedAtRuntime = (
  source: ts.SourceFile,
  names: ReadonlySet<string>,
): boolean => {
  const occurrences = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      occurrences.set(node.text, (occurrences.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...occurrences.values()].some((count) => count > 1);
};

const namedCategory = (
  file: string,
  source: ts.SourceFile,
  text: string,
): ReachabilityCategory | undefined => {
  if (/\b(?:lint|run)SingleRule\s*\(/u.test(text)) {
    return "source-factory";
  }
  if (
    /(?:^|\/)(?:e2e|playwright)(?:\/|[.-])/u.test(file) ||
    /["']@playwright\/test["']/u.test(text)
  ) {
    return "e2e-surface";
  }
  if (/(?:Bun\.spawn|spawnSync|execFile|execa)\s*\(/u.test(text)) {
    return "spawned-entry";
  }
  if (
    /readFile(?:Sync)?\s*\([^)]*\.(?:sql|schema)["'`]/su.test(text) ||
    /(?:drizzle|migration|schema)[^\n]*(?:readFile|glob)/iu.test(text)
  ) {
    return "sql-or-schema-reader";
  }
  if (
    /(?:\.github\/workflows|artifacts?\/|workflow)[^\n]*(?:readFile|Bun\.file|parse)/iu.test(
      text,
    )
  ) {
    return "artifact-or-workflow-guard";
  }
  if (/(?:readFile(?:Sync)?|Bun\.file|globSync|git\W+show)\s*\(/u.test(text)) {
    return "repository-text-guard";
  }
  void source;
  return undefined;
};

const siblingExportNames = (
  repoRoot: string,
  testFile: string,
): Set<string> => {
  const stem = testFile.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, "");
  const names = new Set<string>();
  for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
    const candidate = path.join(repoRoot, `${stem}${extension}`);
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    const source = parse(candidate, readFileSync(candidate, "utf-8"));
    for (const statement of source.statements) {
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }
      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isVariableStatement(statement)
      ) {
        if ("name" in statement && statement.name) {
          names.add(statement.name.text);
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              names.add(declaration.name.text);
            }
          }
        }
      }
    }
  }
  return names;
};

// oxlint-disable-next-line eslint/complexity -- Independent evidence classifiers share one repository traversal.
export const analyzeTestSubjectReachability = ({
  repoRoot,
  files = trackedTests(repoRoot),
}: AnalyzeOptions): ReachabilityFinding[] => {
  const findings: ReachabilityFinding[] = [];
  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    const text = readFileSync(absolute, "utf-8");
    const source = parse(file, text);
    const importedRuntimeNames = new Set<string>();
    const reachedSiblingExports = new Set<string>();
    const siblingStem = path.resolve(
      repoRoot,
      file.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, ""),
    );
    let hasFactory = false;
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const resolvedSource = existingSource(
        repoRoot,
        file,
        statement.moduleSpecifier.text,
      );
      if (!resolvedSource) {
        continue;
      }
      for (const name of namedImports(statement)) {
        importedRuntimeNames.add(name);
        if (/^(?:create|build|make)|Factory$/u.test(name)) {
          hasFactory = true;
        }
      }
      if (resolvedSource.replace(/\.[cm]?[jt]sx?$/u, "") === siblingStem) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const localName = element.name.text;
            if (usedAtRuntime(source, new Set([localName]))) {
              reachedSiblingExports.add(
                element.propertyName?.text ?? localName,
              );
            }
          }
        }
      }
    }
    let category = namedCategory(file, source, text);
    if (usedAtRuntime(source, importedRuntimeNames)) {
      category = hasFactory ? "source-factory" : "imported-source-subject";
    }
    if (!category) {
      findings.push({ file, kind: "no-classified-reachability" });
    }

    const siblingNames = siblingExportNames(repoRoot, file);
    for (const statement of source.statements) {
      let localName: string | undefined;
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        localName = statement.name.text;
      }
      if (
        localName &&
        siblingNames.has(localName) &&
        !/fixture/iu.test(localName) &&
        !reachedSiblingExports.has(localName)
      ) {
        findings.push({
          file,
          kind: "local-export-collision",
          name: localName,
        });
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            siblingNames.has(declaration.name.text) &&
            !/fixture/iu.test(declaration.name.text) &&
            !reachedSiblingExports.has(declaration.name.text) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
          ) {
            findings.push({
              file,
              kind: "local-export-collision",
              name: declaration.name.text,
            });
          }
        }
      }
    }
  }
  return findings.toSorted((left, right) => {
    const leftKey = `${left.file}:${left.kind}:${left.name ?? ""}`;
    const rightKey = `${right.file}:${right.kind}:${right.name ?? ""}`;
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
};

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  if (process.argv.includes("--self-test")) {
    const result = Bun.spawnSync(
      ["bun", "test", "scripts/test-subject-reachability.test.ts"],
      {
        cwd: repoRoot,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exit(childExitStatus(result));
  }
  if (!process.argv.includes("--base")) {
    panic(
      "Usage: bun scripts/test-subject-reachability.ts --self-test | --base",
    );
  }
  const findings = analyzeTestSubjectReachability({ repoRoot });
  const baseline = parseReachabilityBaseline(
    readFileSync(
      path.join(repoRoot, "scripts/test-subject-reachability-baseline.json"),
      "utf-8",
    ),
  );
  const current = new Map<string, string[]>();
  for (const finding of findings) {
    const member = `${finding.kind}${finding.name ? `:${finding.name}` : ""}`;
    current.set(finding.file, [...(current.get(finding.file) ?? []), member]);
  }
  const failures: string[] = [];
  for (const [file, members] of current) {
    const allowed = new Set(baseline[file]);
    for (const member of members) {
      if (!allowed.has(member)) {
        failures.push(`${file}: ${member}`);
      }
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const actual = new Set(current.get(file));
    for (const member of allowed) {
      if (!actual.has(member)) {
        failures.push(`${file}: remove cleaned baseline member ${member}`);
      }
    }
  }
  if (failures.length > 0) {
    panic(`Test subject reachability census failed:\n${failures.join("\n")}`);
  }
}

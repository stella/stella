#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { typescriptModuleReferences } from "../packages/scripts/src/api-typecheck-declarations";
import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SECONDARY_PROJECTS = [
  "apps/api/tsconfig.scripts.json",
  "apps/api/tsconfig.contracts.json",
  "apps/legal-atlas-runner/tsconfig.json",
  "tsconfig.scripts.json",
] as const;

const apiSourceRoot = path.join(REPO_ROOT, "apps/api/src");
const generatedApiDeclarations = path.join(
  REPO_ROOT,
  "apps/api/.cache/typecheck-declarations/apps/api/src",
);

const readProject = (filename: string) => {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    filename,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
        panic(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    },
  );
  if (!parsed || parsed.errors.length > 0) {
    panic(`Cannot read TypeScript project ${filename}`);
  }
  return parsed;
};

type SecondaryImportBoundaryOptions = {
  project: string;
  declarationsProject: string;
  sourceRoot: string;
};

// The producer's root files define the supported import surface. Requiring an
// output also catches missing declaration imports that --listFilesOnly can omit.
export const secondaryImportBoundaryViolations = ({
  project,
  declarationsProject,
  sourceRoot,
}: SecondaryImportBoundaryOptions) => {
  const consumer = readProject(project);
  const producer = readProject(declarationsProject);
  const supportedFiles = new Set(producer.fileNames);
  const cache = ts.createModuleResolutionCache(
    path.dirname(project),
    (filename) => filename,
    consumer.options,
  );
  const violations: string[] = [];
  for (const filename of consumer.fileNames) {
    const references = typescriptModuleReferences(
      readFileSync(filename, "utf-8"),
      filename,
    );
    for (const specifier of references.imports) {
      const resolved = ts.resolveModuleName(
        specifier,
        filename,
        consumer.options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (
        resolved &&
        /\.[cm]?tsx?$/u.test(resolved.resolvedFileName) &&
        apiSourceBoundaryViolations([resolved.resolvedFileName], sourceRoot)
          .length > 0
      ) {
        const target = resolved.resolvedFileName;
        if (!supportedFiles.has(target)) {
          violations.push(`${filename}: unsupported API import ${specifier}`);
        } else if (
          !ts
            .getOutputFileNames(producer, target, false)
            .some(
              (output) => /\.d\.[cm]?ts$/u.test(output) && existsSync(output),
            )
        ) {
          violations.push(`${filename}: missing API declaration ${specifier}`);
        }
      }
    }
  }
  return violations;
};

export const apiSourceBoundaryViolations = (
  files: readonly string[],
  sourceRoot: string,
) =>
  files.filter((file) => {
    if (/\.d\.[cm]?ts$/u.test(file)) {
      return false;
    }
    const relative = path.relative(sourceRoot, path.resolve(file));
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  });

// Use the same resolver as the typecheck task. Listing the graph skips semantic
// checking and also catches transitive source imports and reference redirects.
export const secondaryProgramFiles = (project: string) => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--listFilesOnly",
      "--threads=1",
      "--project",
      project,
    ],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (childExitStatus(child) !== 0) {
    panic(
      `Cannot list TypeScript program ${project}:\n${child.stdout.toString()}${child.stderr.toString()}`,
    );
  }
  const files = child.stdout
    .toString()
    .split(/\r?\n/u)
    .filter((line) => path.isAbsolute(line));
  if (files.length === 0) {
    panic(`No source files listed for ${project}`);
  }
  return files;
};

export const checkApiSecondaryProgramBoundary = () => {
  if (!existsSync(generatedApiDeclarations)) {
    panic(
      `Generated API declarations are missing: ${path.relative(REPO_ROOT, generatedApiDeclarations)}`,
    );
  }
  const violations: string[] = [];
  for (const project of SECONDARY_PROJECTS) {
    violations.push(
      ...secondaryImportBoundaryViolations({
        project: path.join(REPO_ROOT, project),
        declarationsProject: path.join(
          REPO_ROOT,
          "apps/api/tsconfig.declarations.json",
        ),
        sourceRoot: apiSourceRoot,
      }),
    );
    violations.push(
      ...apiSourceBoundaryViolations(
        secondaryProgramFiles(project),
        apiSourceRoot,
      ).map((file) => `${project}: ${path.relative(REPO_ROOT, file)}`),
    );
  }
  return violations;
};

if (import.meta.main) {
  const violations = checkApiSecondaryProgramBoundary();
  if (violations.length > 0) {
    panic(
      `Secondary TypeScript programs must not include apps/api/src implementation files:\n${violations.join("\n")}`,
    );
  }
  console.log(
    `API secondary program boundary: ok (${SECONDARY_PROJECTS.length} projects)`,
  );
}

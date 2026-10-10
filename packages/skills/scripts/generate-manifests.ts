import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  SKILL_FILE_NAME,
  SKILL_RESOURCE_EXTENSIONS,
  isSkillResourceFolder,
  isAllowedFirstPartySkillPackageSkip,
  validateSkillPackage,
} from "../src/format";
import type { SkillPackageFile } from "../src/format";

const packageRoot = path.join(import.meta.dirname, "..");

type ResourceEntry = {
  importName: string;
  path: string;
  sourcePath: string;
};

type PackageEntry = {
  id: string;
  importName: string;
  resources: ResourceEntry[];
  sourcePath: string;
};

type Manifest = {
  entryPrefix: string;
  exportName: "BLUEPRINTS" | "GENERATED_SKILLS";
  outputFileName: "blueprints.gen.ts" | "skills.gen.ts";
  rootName: "blueprints" | "skills";
};

const manifests = [
  {
    entryPrefix: "blueprint",
    exportName: "BLUEPRINTS",
    outputFileName: "blueprints.gen.ts",
    rootName: "blueprints",
  },
  {
    entryPrefix: "skill",
    exportName: "GENERATED_SKILLS",
    outputFileName: "skills.gen.ts",
    rootName: "skills",
  },
] as const satisfies readonly Manifest[];

for (const manifest of manifests) {
  generateManifest(manifest);
}

function generateManifest(manifest: Manifest) {
  const root = path.join(packageRoot, manifest.rootName);
  const outputPath = path.join(packageRoot, "src", manifest.outputFileName);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(path.join(root, id, SKILL_FILE_NAME)))
    .toSorted((left, right) => left.localeCompare(right))
    .map((id, index) => readPackageEntry(root, id, index, manifest));

  const imports = entries.flatMap((entry) => [
    `import ${entry.importName} from "${entry.sourcePath}" with { type: "text" };`,
    ...entry.resources.map(
      (resource) =>
        `import ${resource.importName} from "${resource.sourcePath}" with { type: "text" };`,
    ),
  ]);
  const importBlock = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
  const body =
    entries.length > 0 ? `\n${entries.map(formatEntry).join(",\n")}\n` : "";
  const typeDeclaration =
    manifest.exportName === "GENERATED_SKILLS"
      ? `type GeneratedSkillEntry = {
  id: string;
  source: string;
  resources: readonly {
      path: string;
    source: string;
  }[];
};

`
      : "";
  const typeImport = "";
  const annotation =
    manifest.exportName === "GENERATED_SKILLS"
      ? ": readonly GeneratedSkillEntry[]"
      : "";
  const suffix = manifest.exportName === "BLUEPRINTS" ? " as const" : "";
  const output = `// oxlint-disable-next-line typescript/triple-slash-reference -- loads the ambient "*.md" module declaration; no ES import equivalent
/// <reference path="./markdown.d.ts" />

${typeImport}${importBlock}${typeDeclaration}export const ${manifest.exportName}${annotation} = [${body}]${suffix};
`;

  if (process.argv.includes("--check")) {
    if (readFileSync(outputPath, "utf-8") !== output) {
      panic(`Generated ${manifest.rootName} manifest is out of date`);
    }
    return;
  }
  writeFileSync(outputPath, output);
}

function readPackageEntry(
  root: string,
  id: string,
  index: number,
  manifest: Manifest,
): PackageEntry {
  const packageDir = path.join(root, id);
  const files = readPackageFiles(packageDir);
  const validated = validateSkillPackage({
    files,
    tools: { type: "deferred" },
  });
  if (validated.isErr()) {
    panic(
      `Invalid first-party skill package ${manifest.rootName}/${id}: ${JSON.stringify(validated.error)}`,
    );
  }
  const disallowedSkip = validated.value.skipped.find(
    (skipped) => !isAllowedFirstPartySkillPackageSkip(skipped),
  );
  if (disallowedSkip !== undefined) {
    panic(
      `Invalid first-party skill package ${manifest.rootName}/${id}: skipped ${disallowedSkip.path} (${disallowedSkip.reason})`,
    );
  }

  return {
    id,
    importName: `${manifest.entryPrefix}${index}`,
    resources: validated.value.resources.map((resource, resourceIndex) => {
      if (!isSupportedResourcePath(resource.path)) {
        panic(`Validator returned an unsupported resource: ${resource.path}`);
      }
      return {
        importName: `${manifest.entryPrefix}${index}Resource${resourceIndex}`,
        path: resource.path,
        sourcePath: toImportPath(
          path.join(packageDir, ...resource.path.split("/")),
          manifest,
        ),
      };
    }),
    sourcePath: toImportPath(path.join(packageDir, SKILL_FILE_NAME), manifest),
  };
}

function readPackageFiles(packageDir: string): SkillPackageFile[] {
  const files: SkillPackageFile[] = [];
  collectPackageFiles(packageDir, packageDir, files);
  return files;
}

function collectPackageFiles(
  packageDir: string,
  currentDir: string,
  files: SkillPackageFile[],
) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectPackageFiles(packageDir, entryPath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = path
      .relative(packageDir, entryPath)
      .split(path.sep)
      .join("/");
    files.push({
      content: readFileSync(entryPath, "utf-8"),
      path: relativePath,
    });
  }
}

function isSupportedResourcePath(resourcePath: string): boolean {
  const folder = resourcePath.split("/").at(0) ?? "";
  return (
    isSkillResourceFolder(folder) &&
    SKILL_RESOURCE_EXTENSIONS.some((extension) =>
      resourcePath.endsWith(extension),
    )
  );
}

function formatEntry(entry: PackageEntry): string {
  const resources = entry.resources
    .map(
      (resource) =>
        `      { path: ${JSON.stringify(resource.path)}, source: ${resource.importName} }`,
    )
    .join(",\n");
  const resourcesArray = resources.length > 0 ? `[\n${resources}\n    ]` : "[]";
  return `  {
    id: ${JSON.stringify(entry.id)},
    source: ${entry.importName},
    resources: ${resourcesArray},
  }`;
}

function toImportPath(filePath: string, manifest: Manifest): string {
  const outputPath = path.join(packageRoot, "src", manifest.outputFileName);
  const relativePath = path.relative(path.dirname(outputPath), filePath);
  return relativePath.startsWith(".")
    ? relativePath.split(path.sep).join("/")
    : `./${relativePath.split(path.sep).join("/")}`;
}

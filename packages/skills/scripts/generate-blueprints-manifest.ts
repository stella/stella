import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Blueprints are skill scaffolds: a SKILL.md skeleton plus placeholder
// resource files that teach the recommended folder structure. Unlike the
// bundled skills manifest, blueprints also carry a `references/` tree, so
// this generator scans that root too and maps it to the `reference` kind.
const packageRoot = path.join(import.meta.dirname, "..");
const blueprintsRoot = path.join(packageRoot, "blueprints");
const outputPath = path.join(packageRoot, "src", "blueprints.gen.ts");
const skillFileName = "SKILL.md";

const resourceRoots = {
  knowledge: "knowledge",
  prompts: "prompt",
  references: "reference",
} as const;
const resourceExtensions = [".md", ".prompt.md", ".txt"] as const;

type ResourceKind = (typeof resourceRoots)[keyof typeof resourceRoots];

type ResourceEntry = {
  importName: string;
  kind: ResourceKind;
  path: string;
  sourcePath: string;
};

type BlueprintEntry = {
  id: string;
  importName: string;
  resources: ResourceEntry[];
  sourcePath: string;
};

const blueprintEntries = readdirSync(blueprintsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((blueprintId) =>
    existsSync(path.join(blueprintsRoot, blueprintId, skillFileName)),
  )
  .sort((a, b) => a.localeCompare(b))
  .map((blueprintId, index): BlueprintEntry => {
    const blueprintDir = path.join(blueprintsRoot, blueprintId);
    return {
      id: blueprintId,
      importName: `blueprint${index}`,
      resources: listResources(blueprintDir, index),
      sourcePath: toImportPath(path.join(blueprintDir, skillFileName)),
    };
  });

const imports = blueprintEntries.flatMap((blueprint) => [
  `import ${blueprint.importName} from "${blueprint.sourcePath}" with { type: "text" };`,
  ...blueprint.resources.map(
    (resource) =>
      `import ${resource.importName} from "${resource.sourcePath}" with { type: "text" };`,
  ),
]);

const output = `// eslint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="./markdown.d.ts" />

${imports.join("\n")}

export const BLUEPRINTS = [
${blueprintEntries.map(formatBlueprintEntry).join(",\n")}
] as const;
`;

if (process.argv.includes("--check")) {
  const currentOutput = readFileSync(outputPath, "utf-8");
  if (currentOutput !== output) {
    panic("Generated blueprints manifest is out of date");
  }
} else {
  writeFileSync(outputPath, output);
}

function listResources(
  blueprintDir: string,
  blueprintIndex: number,
): ResourceEntry[] {
  const resources: ResourceEntry[] = [];

  for (const [rootName, kind] of Object.entries(resourceRoots)) {
    const rootDir = path.join(blueprintDir, rootName);
    if (!existsSync(rootDir)) {
      continue;
    }

    collectResources({
      baseDir: blueprintDir,
      currentDir: rootDir,
      kind,
      resources,
    });
  }

  return resources
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((resource, resourceIndex) => ({
      importName: `blueprint${blueprintIndex}Resource${resourceIndex}`,
      kind: resource.kind,
      path: resource.path,
      sourcePath: resource.sourcePath,
    }));
}

function collectResources({
  baseDir,
  currentDir,
  kind,
  resources,
}: {
  baseDir: string;
  currentDir: string;
  kind: ResourceKind;
  resources: ResourceEntry[];
}) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      collectResources({ baseDir, currentDir: entryPath, kind, resources });
      continue;
    }

    if (!entry.isFile() || !hasAllowedResourceExtension(entry.name)) {
      continue;
    }

    resources.push({
      importName: "",
      kind,
      path: path.relative(baseDir, entryPath).split(path.sep).join("/"),
      sourcePath: toImportPath(entryPath),
    });
  }
}

function formatBlueprintEntry(blueprint: BlueprintEntry): string {
  const resources = blueprint.resources
    .map(
      (resource) =>
        `      { kind: ${JSON.stringify(resource.kind)}, path: ${JSON.stringify(resource.path)}, source: ${resource.importName} }`,
    )
    .join(",\n");

  return `  {
    id: ${JSON.stringify(blueprint.id)},
    source: ${blueprint.importName},
    resources: [
${resources}
    ],
  }`;
}

function toImportPath(filePath: string): string {
  const relativePath = path.relative(path.dirname(outputPath), filePath);
  return relativePath.startsWith(".")
    ? relativePath.split(path.sep).join("/")
    : `./${relativePath.split(path.sep).join("/")}`;
}

function hasAllowedResourceExtension(resourcePath: string): boolean {
  return resourceExtensions.some((extension) =>
    resourcePath.endsWith(extension),
  );
}

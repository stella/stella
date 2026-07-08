import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const packageRoot = path.join(import.meta.dirname, "..");
const skillsRoot = path.join(packageRoot, "skills");
const outputPath = path.join(packageRoot, "src", "skills.gen.ts");
const skillFileName = "SKILL.md";
const resourceRoots = ["knowledge", "prompts"] as const;
const resourceExtensions = [".md", ".prompt.md"] as const;

type ResourceEntry = {
  importName: string;
  kind: "knowledge" | "prompt";
  path: string;
  sourcePath: string;
};

type SkillEntry = {
  id: string;
  importName: string;
  resources: ResourceEntry[];
  sourcePath: string;
};

const skillEntries = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((skillId) =>
    existsSync(path.join(skillsRoot, skillId, skillFileName)),
  )
  .sort((a, b) => a.localeCompare(b))
  .map((skillId, index): SkillEntry => {
    const skillDir = path.join(skillsRoot, skillId);
    return {
      id: skillId,
      importName: `skill${index}`,
      resources: listResources(skillDir, index),
      sourcePath: toImportPath(path.join(skillDir, skillFileName)),
    };
  });

const imports = skillEntries.flatMap((skill) => [
  `import ${skill.importName} from "${skill.sourcePath}" with { type: "text" };`,
  ...skill.resources.map(
    (resource) =>
      `import ${resource.importName} from "${resource.sourcePath}" with { type: "text" };`,
  ),
]);
const importBlock = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
const generatedSkillsBody =
  skillEntries.length > 0
    ? `\n${skillEntries.map(formatSkillEntry).join(",\n")}\n`
    : "";

const output = `// eslint-disable-next-line typescript-eslint/triple-slash-reference -- loads the ambient "*.md" module declaration; no ES import equivalent
/// <reference path="./markdown.d.ts" />

${importBlock}\
type GeneratedSkillEntry = {
  id: string;
  source: string;
  resources: readonly {
    kind: "knowledge" | "prompt";
    path: string;
    source: string;
  }[];
};

export const GENERATED_SKILLS: readonly GeneratedSkillEntry[] = [${generatedSkillsBody}];
`;

if (process.argv.includes("--check")) {
  const currentOutput = readFileSync(outputPath, "utf-8");
  if (currentOutput !== output) {
    panic("Generated skills manifest is out of date");
  }
} else {
  writeFileSync(outputPath, output);
}

function listResources(skillDir: string, skillIndex: number): ResourceEntry[] {
  const resources: ResourceEntry[] = [];

  for (const rootName of resourceRoots) {
    const rootDir = path.join(skillDir, rootName);
    if (!existsSync(rootDir)) {
      continue;
    }

    collectResources({
      baseDir: skillDir,
      currentDir: rootDir,
      importPrefix: `skill${skillIndex}Resource`,
      kind: rootName === "knowledge" ? "knowledge" : "prompt",
      resources,
    });
  }

  return resources
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((resource, resourceIndex) => ({
      importName: `skill${skillIndex}Resource${resourceIndex}`,
      kind: resource.kind,
      path: resource.path,
      sourcePath: resource.sourcePath,
    }));
}

function collectResources({
  baseDir,
  currentDir,
  importPrefix,
  kind,
  resources,
}: {
  baseDir: string;
  currentDir: string;
  importPrefix: string;
  kind: ResourceEntry["kind"];
  resources: ResourceEntry[];
}) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      collectResources({
        baseDir,
        currentDir: entryPath,
        importPrefix,
        kind,
        resources,
      });
      continue;
    }

    if (!entry.isFile() || !hasAllowedResourceExtension(entry.name)) {
      continue;
    }

    resources.push({
      importName: importPrefix,
      kind,
      path: path.relative(baseDir, entryPath).split(path.sep).join("/"),
      sourcePath: toImportPath(entryPath),
    });
  }
}

function formatSkillEntry(skill: SkillEntry): string {
  const resources = skill.resources
    .map(
      (resource) =>
        `      { kind: ${JSON.stringify(resource.kind)}, path: ${JSON.stringify(resource.path)}, source: ${resource.importName} }`,
    )
    .join(",\n");

  return `  {
    id: ${JSON.stringify(skill.id)},
    source: ${skill.importName},
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

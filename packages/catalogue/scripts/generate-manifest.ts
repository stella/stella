/**
 * Globs `entries/<kind>/<slug>/manifest.json` + `icon.svg`, emits
 * `src/catalogue.gen.ts` with public manifests pre-imported, and emits
 * API-only skill install payloads into a separate module. Same trick
 * as `packages/skills/scripts/generate-manifest.ts`: keeps production
 * code filesystem-free and lets bundlers tree-shake.
 *
 * Run via `bun run generate` after adding/editing an entry; CI
 * verifies the file is up to date via `--check`.
 */
import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CATALOGUE_KINDS } from "../src/schema";

const packageRoot = path.join(import.meta.dirname, "..");
const entriesRoot = path.join(packageRoot, "entries");
const outputPath = path.join(packageRoot, "src", "catalogue.gen.ts");
const installPayloadsOutputPath = path.join(
  packageRoot,
  "src",
  "catalogue-install-payloads.gen.ts",
);

type GeneratedEntry = {
  importName: string;
  manifestPath: string;
  /** JSON-encoded string literal — already wrapped in quotes — or "null". */
  iconLiteral: string;
  skillPayload: GeneratedSkillPayload | null;
};

type GeneratedResourceFile = {
  content: string;
  path: string;
  sizeBytes: number;
};

type GeneratedSkillPayload = {
  bodyLiteral: string;
  resourceFilesLiteral: string;
  slugLiteral: string;
};

const entries = CATALOGUE_KINDS.flatMap((kind) => {
  const kindDir = path.join(entriesRoot, pluralize(kind));
  if (!existsSync(kindDir)) {
    return [];
  }
  return readdirSync(kindDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((slug): GeneratedEntry | null => {
      const folder = path.join(kindDir, slug);
      const manifest = path.join(folder, "manifest.json");
      if (!existsSync(manifest)) {
        return null;
      }
      const importName = toImportName(kind, slug);

      let skillPayload: GeneratedSkillPayload | null = null;
      if (kind === "skill") {
        const manifestRaw: { entryPath?: string; resources?: string[] } =
          JSON.parse(readFileSync(manifest, "utf-8"));
        const entryPath = normalizeManifestPath(
          manifestRaw.entryPath ?? "SKILL.md",
        );
        const entryDirectory = path.dirname(entryPath);
        const resourceRoot =
          entryDirectory === "." ? folder : path.join(folder, entryDirectory);
        const bodyFile = path.join(folder, entryPath);
        if (!existsSync(bodyFile)) {
          panic(`${kind}/${slug}: entry file not found: ${entryPath}`);
        }
        const resourceFiles: GeneratedResourceFile[] = (
          manifestRaw.resources ?? []
        ).map((resourcePath) => {
          const normalizedPath = normalizeManifestPath(resourcePath);
          const resourceFile = path.join(resourceRoot, normalizedPath);
          if (!existsSync(resourceFile)) {
            panic(
              `${kind}/${slug}: resource file not found: ${normalizedPath}`,
            );
          }
          const content = readFileSync(resourceFile, "utf-8");
          return {
            content,
            path: normalizedPath,
            sizeBytes: Buffer.byteLength(content, "utf-8"),
          };
        });
        skillPayload = {
          bodyLiteral: JSON.stringify(readFileSync(bodyFile, "utf-8")),
          resourceFilesLiteral: JSON.stringify(resourceFiles),
          slugLiteral: JSON.stringify(slug),
        };
      }

      // Icons are inlined as inert image data URLs. SVGs are encoded
      // rather than injected as markup so contributor-provided icons
      // cannot execute active content in the app context.
      const iconPng = path.join(folder, "icon.png");
      const iconSvg = path.join(folder, "icon.svg");
      let iconLiteral = "null";
      if (existsSync(iconPng)) {
        const base64 = readFileSync(iconPng).toString("base64");
        iconLiteral = JSON.stringify(`data:image/png;base64,${base64}`);
      } else if (existsSync(iconSvg)) {
        const base64 = Buffer.from(
          readFileSync(iconSvg, "utf-8"),
          "utf-8",
        ).toString("base64");
        iconLiteral = JSON.stringify(`data:image/svg+xml;base64,${base64}`);
      }

      return {
        importName,
        manifestPath: toImportPath(manifest),
        iconLiteral,
        skillPayload,
      };
    })
    .filter((entry): entry is GeneratedEntry => entry !== null);
});

const importLines = entries.map(
  (entry) =>
    `import ${entry.importName} from "${entry.manifestPath}" with { type: "json" };`,
);

const recommendedPath = toImportPath(
  path.join(packageRoot, "entries", "recommended.json"),
);
importLines.push(
  `import recommended from "${recommendedPath}" with { type: "json" };`,
);

const entryRows = entries.map(
  (entry) => `  { manifest: ${entry.importName}, icon: ${entry.iconLiteral} }`,
);

const skillPayloadRows = entries
  .map((entry) => entry.skillPayload)
  .filter((payload): payload is GeneratedSkillPayload => payload !== null)
  .map(
    (payload) =>
      `  { slug: ${payload.slugLiteral}, body: ${payload.bodyLiteral}, resourceFiles: ${payload.resourceFilesLiteral} }`,
  );

const output = `// Generated by packages/catalogue/scripts/generate-manifest.ts. Do not edit.

${importLines.join("\n")}

export const GENERATED_ENTRIES = [
${formatRows(entryRows)}
] as const;

export const GENERATED_RECOMMENDED = recommended;
`;

const installPayloadsOutput = `// Generated by packages/catalogue/scripts/generate-manifest.ts. Do not edit.

export const GENERATED_SKILL_INSTALL_PAYLOADS = [
${formatRows(skillPayloadRows)}
] as const;
`;

if (process.argv.includes("--check")) {
  assertGeneratedFileCurrent({
    content: output,
    path: outputPath,
  });
  assertGeneratedFileCurrent({
    content: installPayloadsOutput,
    path: installPayloadsOutputPath,
  });
} else {
  writeFileSync(outputPath, output);
  writeFileSync(installPayloadsOutputPath, installPayloadsOutput);
}

function assertGeneratedFileCurrent({
  content,
  path: targetPath,
}: {
  content: string;
  path: string;
}) {
  if (!existsSync(targetPath)) {
    panic(
      "Generated catalogue manifest does not exist; run `bun run generate`",
    );
  }
  const current = readFileSync(targetPath, "utf-8");
  if (current !== content) {
    panic(
      "Generated catalogue manifest is out of date; run `bun run generate`",
    );
  }
}

function formatRows(rows: readonly string[]): string {
  if (rows.length === 0) {
    return "";
  }
  return `${rows.join(",\n")},`;
}

function pluralize(kind: (typeof CATALOGUE_KINDS)[number]): string {
  if (kind === "native-tool") {
    return "native-tools";
  }
  return `${kind}s`;
}

function toImportName(kind: string, slug: string): string {
  const camel = `${kind}-${slug}`.replace(/-([a-z0-9])/gu, (_, ch: string) =>
    ch.toUpperCase(),
  );
  return camel.replace(/^[a-z]/u, (ch) => ch.toLowerCase());
}

function toImportPath(absolutePath: string): string {
  const srcDir = path.join(packageRoot, "src");
  const relative = path.relative(srcDir, absolutePath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function normalizeManifestPath(rawPath: string): string {
  if (rawPath.startsWith("/")) {
    panic(`Catalogue path must be relative: ${rawPath}`);
  }

  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    panic(`Catalogue path escapes its entry folder: ${rawPath}`);
  }

  return normalized;
}

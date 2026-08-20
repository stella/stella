/**
 * Generate `src/packs.gen.ts` from the content repository mounted at
 * `content/`: every `packs/<id>/pack.json` is validated against the content
 * contract, each DOCX is hashed, and the result is emitted as typed data the
 * loader resolves against the content root at runtime.
 *
 * `--fixtures` targets the committed test content under `src/fixtures/`
 * instead; `--check` fails when the committed output is stale. A checkout
 * without the submodule cannot regenerate the manifest, so `--check` reports
 * and passes there; CI checks out submodules and enforces it.
 */

import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  packIndexSchema,
  packManifestSchema,
  type GeneratedTemplatePack,
  type GeneratedTemplatePackTemplate,
  type PackIndexTemplate,
} from "../src/schema";

const packageRoot = path.join(import.meta.dirname, "..");
const useFixtures = process.argv.includes("--fixtures");
const checkOnly = process.argv.includes("--check");

const contentRoot = useFixtures
  ? path.join(packageRoot, "src", "fixtures", "content")
  : path.join(packageRoot, "content");
const outputPath = useFixtures
  ? path.join(packageRoot, "src", "fixtures", "packs.gen.ts")
  : path.join(packageRoot, "src", "packs.gen.ts");
const schemaImportPath = useFixtures ? "../schema" : "./schema";

type EmittedPack = Omit<GeneratedTemplatePack, "templates"> & {
  templates: GeneratedTemplatePackTemplate[];
};

const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const readJson = (filePath: string): unknown =>
  JSON.parse(readFileSync(filePath, "utf-8"));

/** `index.json` is optional while the content repository is being built;
 *  when present its hashes must agree with the bytes on disk. */
const readIndex = (): ReadonlyMap<string, PackIndexTemplate> => {
  const indexPath = path.join(contentRoot, "index.json");
  const indexed = new Map<string, PackIndexTemplate>();
  if (!existsSync(indexPath)) {
    return indexed;
  }
  const parsed = v.safeParse(packIndexSchema, readJson(indexPath));
  if (!parsed.success) {
    panic(`Invalid content index at ${indexPath}`);
  }
  for (const pack of parsed.output) {
    for (const template of pack.templates) {
      indexed.set(`${pack.id}/${template.slug}`, template);
    }
  }
  return indexed;
};

type EffectiveTemplateValues = Pick<
  GeneratedTemplatePackTemplate,
  "jurisdictions" | "languages" | "legalArea" | "license"
>;

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const assertIndexAgrees = ({
  effective,
  indexed,
  ref,
}: {
  effective: EffectiveTemplateValues;
  indexed: PackIndexTemplate | undefined;
  ref: string;
}): void => {
  if (!indexed) {
    return;
  }
  const disagreements = [
    indexed.license !== undefined && indexed.license !== effective.license
      ? "license"
      : null,
    indexed.jurisdictions !== undefined &&
    !sameJson(indexed.jurisdictions, effective.jurisdictions)
      ? "jurisdictions"
      : null,
    indexed.languages !== undefined &&
    !sameJson(indexed.languages, effective.languages)
      ? "languages"
      : null,
    indexed.legalArea !== undefined && indexed.legalArea !== effective.legalArea
      ? "legalArea"
      : null,
  ].filter((field) => field !== null);
  if (disagreements.length > 0) {
    panic(
      `index.json disagrees with pack.json for ${ref}: ${disagreements.join(", ")}`,
    );
  }
};

const listPackDirectories = (): string[] => {
  const packsRoot = path.join(contentRoot, "packs");
  if (!existsSync(packsRoot)) {
    return [];
  }
  return readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packsRoot, entry.name))
    .filter((packDir) => existsSync(path.join(packDir, "pack.json")))
    .sort((a, b) => a.localeCompare(b));
};

const readPack = ({
  index,
  packDir,
}: {
  index: ReadonlyMap<string, PackIndexTemplate>;
  packDir: string;
}): EmittedPack => {
  const manifestPath = path.join(packDir, "pack.json");
  const parsed = v.safeParse(packManifestSchema, readJson(manifestPath));
  if (!parsed.success) {
    const issues = parsed.issues
      .map((issue) => `${v.getDotPath(issue) ?? "<root>"}: ${issue.message}`)
      .join("; ");
    panic(`Invalid pack manifest at ${manifestPath}: ${issues}`);
  }
  const manifest = parsed.output;
  if (manifest.id !== path.basename(packDir)) {
    panic(
      `Pack id "${manifest.id}" does not match its directory ${path.basename(packDir)}`,
    );
  }
  const slugs = new Set<string>();

  const templates = manifest.templates.map(
    (template): GeneratedTemplatePackTemplate => {
      if (slugs.has(template.slug)) {
        panic(`Duplicate template slug "${template.slug}" in ${manifestPath}`);
      }
      slugs.add(template.slug);

      const docxPath = path.join(packDir, template.file);
      const readmePath = path.join(packDir, template.readme);
      if (!existsSync(docxPath)) {
        panic(`Missing DOCX ${docxPath} for ${manifest.id}/${template.slug}`);
      }
      if (!existsSync(readmePath)) {
        panic(
          `Missing README ${readmePath} for ${manifest.id}/${template.slug}`,
        );
      }
      const sha256 = sha256Hex(new Uint8Array(readFileSync(docxPath)));
      const ref = `${manifest.id}/${template.slug}`;
      const indexed = index.get(ref);
      if (indexed && indexed.sha256 !== sha256) {
        panic(`index.json hash for ${ref} does not match the DOCX on disk`);
      }

      // Effective values: the template's own, else the pack's. index.json
      // resolves the same inheritance upstream; where it states a value it
      // must agree, or the index is stale.
      const effective = {
        jurisdictions: template.jurisdictions ?? manifest.jurisdictions,
        languages: template.languages ?? manifest.languages,
        legalArea: template.legalArea ?? null,
        license: template.license ?? manifest.license,
      };
      assertIndexAgrees({ ref, indexed, effective });

      return {
        slug: template.slug,
        title: template.title,
        file: template.file,
        readmeFile: template.readme,
        ...effective,
        fields: indexed?.fields ?? [],
        sha256,
        readme: readFileSync(readmePath, "utf-8"),
      };
    },
  );

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    licenseUrl: manifest.licenseUrl ?? null,
    source: manifest.source ?? null,
    authors: manifest.authors,
    jurisdictions: manifest.jurisdictions,
    languages: manifest.languages,
    legalAreas: manifest.legalAreas,
    lastReviewedAt: manifest.lastReviewedAt ?? null,
    disclaimer: manifest.disclaimer ?? null,
    templates,
  };
};

const literal = (value: unknown): string => JSON.stringify(value);

const formatTemplate = (
  template: GeneratedTemplatePackTemplate,
): string => `      {
        slug: ${literal(template.slug)},
        title: ${literal(template.title)},
        file: ${literal(template.file)},
        readmeFile: ${literal(template.readmeFile)},
        jurisdictions: ${literal(template.jurisdictions)},
        languages: ${literal(template.languages)},
        legalArea: ${literal(template.legalArea)},
        license: ${literal(template.license)},
        fields: ${literal(template.fields)},
        sha256: ${literal(template.sha256)},
        readme: ${literal(template.readme)},
      }`;

const formatPack = (pack: EmittedPack): string => `  {
    id: ${literal(pack.id)},
    name: ${literal(pack.name)},
    version: ${literal(pack.version)},
    description: ${literal(pack.description)},
    license: ${literal(pack.license)},
    licenseUrl: ${literal(pack.licenseUrl)},
    source: ${literal(pack.source)},
    authors: ${literal(pack.authors)},
    jurisdictions: ${literal(pack.jurisdictions)},
    languages: ${literal(pack.languages)},
    legalAreas: ${literal(pack.legalAreas)},
    lastReviewedAt: ${literal(pack.lastReviewedAt)},
    disclaimer: ${literal(pack.disclaimer)},
    templates: [
${pack.templates.map(formatTemplate).join(",\n")}
    ],
  }`;

// A checkout without the content submodule cannot tell whether the committed
// manifest is stale, and must not overwrite it; CI checks out submodules, so
// the check runs there.
if (!useFixtures && !existsSync(path.join(contentRoot, "packs"))) {
  if (!checkOnly) {
    panic(
      "template-packs content is not initialised; run git submodule update --init packages/template-packs/content",
    );
  }
  console.log(
    "template-packs content is not initialised; skipping the manifest check.",
  );
  process.exit(0);
}

const index = readIndex();
const packs = listPackDirectories().map((packDir) =>
  readPack({ index, packDir }),
);
const packIds = new Set<string>();
for (const pack of packs) {
  if (packIds.has(pack.id)) {
    panic(`Duplicate pack id "${pack.id}"`);
  }
  packIds.add(pack.id);
}

const body = packs.length > 0 ? `\n${packs.map(formatPack).join(",\n")}\n` : "";

const output = `// Generated by scripts/generate-manifest.ts; do not edit.
import type { GeneratedTemplatePack } from "${schemaImportPath}";

export const GENERATED_TEMPLATE_PACKS: readonly GeneratedTemplatePack[] = [${body}];
`;

if (checkOnly) {
  const current = existsSync(outputPath)
    ? readFileSync(outputPath, "utf-8")
    : null;
  if (current !== output) {
    panic(
      `${path.relative(packageRoot, outputPath)} is out of date; run bun run generate`,
    );
  }
} else {
  writeFileSync(outputPath, output);
}
